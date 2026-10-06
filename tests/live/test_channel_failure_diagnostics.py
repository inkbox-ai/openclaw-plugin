"""Credential-free exact-case observer contracts; no live requests or model work."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace as NS

import pytest
import channel_failure_diagnostics as obs


def request():
    return {"source_id": "00000000-0000-0000-0000-000000000001", "source_pid": "00000000-0000-0000-0000-000000000002",
            "aut_pid": "00000000-0000-0000-0000-000000000003", "source_phone": "+15550000001", "aut_phone": "+15550000002",
            "text": "Send email with current code abcdef. Return NO_REPLY.", "marker": "abcdef",
            "created_at": "2026-10-06T18:00:00+00:00"}


def fixture():
    calls = []
    result = NS(id=request()["source_id"], created_at=datetime(2026, 10, 6, 18, tzinfo=timezone.utc))
    class Resource:
        def send(self, *args, **kwargs):
            calls.append((self, args, kwargs))
            return result
    resource = Resource()
    xc = {"remote": NS(texts=resource), "remote_pid": request()["source_pid"], "aut_pid": request()["aut_pid"],
          "remote_phone": request()["source_phone"], "aut_phone": request()["aut_phone"]}
    module = NS(_token=lambda: request()["marker"])
    return module, xc, calls, result


def test_exact_send_args_receiver_result_and_token_preserved_without_reads():
    module, xc, calls, result = fixture()
    original_token, original_send = module._token, xc["remote"].texts.send
    scope = {"requests": []}
    restore = obs.install(module, xc, scope)
    assert module._token() == request()["marker"]
    assert xc["remote"].texts.send(xc["remote_pid"], to=xc["aut_phone"], text=request()["text"]) is result
    assert calls == [(xc["remote"].texts, (xc["remote_pid"],), {"to": xc["aut_phone"], "text": request()["text"]})]
    assert scope["requests"] == [request()]
    restore()
    assert module._token is original_token and xc["remote"].texts.send == original_send
    assert "send" not in vars(xc["remote"].texts)


def test_published_sdk_send_capture_has_stable_resource_datetime_and_identical_result(monkeypatch):
    from inkbox import Inkbox
    import httpx
    source = request()
    calls = []
    def handle(req):
        calls.append((req.method, req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"id": source["source_id"], "direction": "outbound",
            "local_phone_number": source["source_phone"], "remote_phone_number": source["aut_phone"],
            "text": source["text"], "type": "sms", "is_read": False,
            "created_at": source["created_at"], "updated_at": source["created_at"], "delivery_status": "queued"})
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    with Inkbox(api_key="synthetic-not-secret", base_url="https://fixture.invalid", timeout=.5) as client:
        assert client.texts is client.texts
        resource, original_send, returned = client.texts, client.texts.send, []
        def record(*args, **kwargs):
            result = original_send(*args, **kwargs)
            returned.append(result)
            return result
        resource.send = record
        xc = {"remote": client, "remote_pid": source["source_pid"], "aut_pid": source["aut_pid"],
              "remote_phone": source["source_phone"], "aut_phone": source["aut_phone"]}
        module, scope = NS(_token=lambda: source["marker"]), {"requests": []}
        restore = obs.install(module, xc, scope)
        try:
            assert module._token() == source["marker"]
            result = client.texts.send(source["source_pid"], to=source["aut_phone"], text=source["text"])
            assert result is returned[0] and isinstance(result.created_at, datetime)
            assert scope["requests"] == [source]
            assert len(calls) == 1 and calls[0][:2] == ("POST", f'/api/v1/phone/numbers/{source["source_pid"]}/texts')
            assert calls[0][2]["text"] == source["text"] and calls[0][2]["to"] == source["aut_phone"]
        finally:
            restore()
        assert resource.send is record


def test_original_exception_identity_and_existing_instance_method_restored():
    module, xc, _, _ = fixture()
    error = RuntimeError("private failure")
    calls = []
    def fail(*args, **kwargs):
        calls.append((args, kwargs))
        raise error
    xc["remote"].texts.send = fail
    restore = obs.install(module, xc, {"requests": []})
    with pytest.raises(RuntimeError) as caught:
        xc["remote"].texts.send("anything")
    assert caught.value is error and calls == [(("anything",), {})]
    restore()
    assert xc["remote"].texts.send is fail


def test_capture_bounds_and_foreign_destination_never_change_send():
    module, xc, calls, result = fixture()
    scope = {"requests": []}
    restore = obs.install(module, xc, scope)
    module._token()
    for _ in range(6):
        assert xc["remote"].texts.send(xc["remote_pid"], to=xc["aut_phone"], text=request()["text"]) is result
    assert len(scope["requests"]) == 4 and scope["truncated"] is True and len(calls) == 6
    xc["remote"].texts.send(xc["remote_pid"], to="+15559999999", text=request()["text"])
    assert scope["unavailable"] is True and len(calls) == 7
    restore()


def test_projection_drops_private_fields_and_invalid_enum_types():
    assert obs.safe_record({"phase": [], "status": "observed"}) is None
    assert obs.safe_record({"phase": "source", "status": "observed", "id": "private", "text": "private",
                            "delivery": ["secret"], "error_code": "private", "matches": True,
                            "accepted": True, "completion": "unknown"}) == {
        "phase": "source", "status": "observed", "accepted": True, "completion": "unknown"}


@pytest.mark.parametrize("scenario", ["matching", "foreign", "duplicate", "empty", "server_error", "full",
                                    "delivery_failed", "delivery_unconfirmed", "sending_failed", "blocked_spam_filter"])
def test_published_sdk_exact_request_and_bounded_inbound_contract(monkeypatch, scenario):
    from inkbox import Inkbox
    import httpx
    source = request()
    calls = []
    failure_statuses = {"delivery_failed", "delivery_unconfirmed", "sending_failed", "blocked_spam_filter"}
    def row(inbound=False):
        return {"id": source["source_id"], "direction": "inbound" if inbound else "outbound",
                "local_phone_number": source["aut_phone"] if inbound else source["source_phone"],
                "remote_phone_number": source["source_phone"] if inbound else source["aut_phone"],
                "text": source["text"], "type": "sms", "is_read": False, "created_at": source["created_at"],
                "updated_at": source["created_at"], "delivery_status": None if inbound else scenario if scenario in failure_statuses else "delivered"}
    def handle(req):
        calls.append((req.method, req.url.path, dict(req.url.params)))
        if len(calls) == 1:
            value = row()
            if scenario == "foreign":
                value["remote_phone_number"] = "+15559999999"
            if scenario == "server_error":
                return httpx.Response(502, json={"error": "private"})
            return httpx.Response(200, json=value)
        values = [] if scenario == "empty" else [row(True)] * (2 if scenario == "duplicate" else 1)
        if scenario == "full":
            other = {**row(True), "text": "unrelated"}
            values += [other] * 49
        return httpx.Response(200, json=values)
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    rows = obs.read_request(source, lambda role: Inkbox(api_key="synthetic-not-secret", base_url="https://fixture.invalid", timeout=.5))
    assert calls[0] == ("GET", f'/api/v1/phone/numbers/{source["source_pid"]}/texts/{source["source_id"]}', {})
    if scenario in {"foreign", "server_error"}:
        assert len(calls) == 1 and rows == [{"phase": "source", "status": "unavailable", "accepted": True}]
    else:
        assert calls[1] == ("GET", f'/api/v1/phone/numbers/{source["aut_pid"]}/texts', {"limit": "50", "offset": "0", "start_datetime": source["created_at"]})
        assert len(calls) == 2 and rows[0]["accepted"] is True
        if scenario in failure_statuses:
            assert rows[0]["delivery"] == scenario and rows[0]["failed"] is False
            assert obs.safe_record(rows[0])["delivery"] == scenario
        assert rows[1]["matches"] == {"matching": 1, "duplicate": 2, "empty": 0, "full": 1}.get(scenario, 1)
        assert rows[1]["ambiguous"] is (scenario == "duplicate")
        assert ("inbound_id" in source) is (scenario == "matching" or scenario in failure_statuses)
        assert rows[1]["page_full"] is (scenario == "full")


def test_bounded_child_reprojects_and_rejects_extra_records():
    good = 'import json;print(json.dumps([{"phase":"source","status":"observed","text":"private","accepted":True}]))'
    assert obs.bounded_child([sys.executable, "-c", good], {}) == [{"phase": "source", "status": "observed", "accepted": True}]
    bad = 'import json;print(json.dumps([{"phase":"source","status":"observed"}]*17))'
    with pytest.raises(ValueError):
        obs.bounded_child([sys.executable, "-c", bad], {})


def test_child_timeout_bounds_stalled_stdin_and_reaps(tmp_path):
    pidfile = tmp_path / "pid"
    script = 'import os,time;open(os.environ["DIAG_PID"],"w").write(str(os.getpid()));time.sleep(30)'
    env_key = "DIAG_PID"
    previous = os.environ.get(env_key)
    os.environ[env_key] = str(pidfile)
    try:
        with pytest.raises(TimeoutError):
            obs.bounded_child([sys.executable, "-c", script], {"text": "x" * 70_000}, timeout=3)
        assert pidfile.exists()
        with pytest.raises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)
    finally:
        if previous is None:
            os.environ.pop(env_key, None)
        else:
            os.environ[env_key] = previous


def test_child_output_bound_and_unavailable_not_zero():
    with pytest.raises(ValueError):
        obs.bounded_child([sys.executable, "-c", 'print("x"*100000)'], {})
    assert obs.observe({"requests": []}) == [{"phase": "observer", "status": "unavailable"}]


@pytest.mark.parametrize("target,failed", [(True, True), (False, True), (True, False)])
def test_real_pytest_failure_finally_and_exact_case_scope(tmp_path, target, failed):
    # A nested failure fixture must never inherit CI identities/model secrets.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "PYTHONPYCACHEPREFIX", "PYTEST_ADDOPTS") if key in os.environ}
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    name = obs.CASE if target else "test_other_case"
    (tmp_path / "test_cross_channel.py").write_text('''
import os
from types import SimpleNamespace as NS
import pytest
assert not any(k.endswith("API_KEY") or k.startswith(("LIVE_", "AUT_", "REMOTE_INKBOX", "OPENCLAW_INKBOX")) for k in os.environ)
@pytest.fixture
def xc():
    class Resource:
        def send(self,*a,**kw): return NS(id="synthetic",created_at=None)
    yield dict(remote=NS(texts=Resource()),remote_pid="source",aut_pid="aut",remote_phone="+15550000001",aut_phone="+15550000002")
    open("finally.txt","w").write("done")
def _token(): return "abcdef"
def ''' + name + '''(xc):
    code=_token()
    xc["remote"].texts.send("source",to="+15550000002",text="code "+code)
    assert ''' + str(not failed) + ''', "original predicate"
''')
    result = subprocess.run([sys.executable, str(Path(obs.__file__).resolve()), "test_cross_channel.py", "-q", "--tb=short"],
                            cwd=tmp_path, env=env, text=True, capture_output=True, timeout=20)
    assert result.returncode == (1 if failed else 0)
    if failed:
        assert "original predicate" in result.stdout
    assert (tmp_path / "finally.txt").read_text() == "done"
    assert ("channel_failure_diagnostic " in result.stdout) is (target and failed)
    if target and failed:
        assert '"status": "unavailable"' in result.stdout and "synthetic" not in result.stdout


def test_outer_timeout_terminates_native_descendant_group(tmp_path):
    pidfile = tmp_path / "descendant.pid"
    grandchild = "import os,time;open(" + repr(str(pidfile)) + ",'w').write(str(os.getpid()));time.sleep(30)"
    parent = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "]);time.sleep(30)"
    try:
        with pytest.raises(TimeoutError):
            obs.bounded_child([sys.executable, "-c", parent], {}, timeout=3)
        assert pidfile.exists(), "descendant must actually start before the timeout"
        pid = int(pidfile.read_text())
        status = Path(f"/proc/{pid}/stat")
        assert not status.exists() or status.read_text().split()[2] == "Z", "descendant survived observer timeout"
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text()), 9)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize("observer_raises", [False, True])
def test_late_call_during_failed_case_observation_is_owned_by_existing_cleanup(tmp_path, observer_raises):
    import shutil
    import conftest as live
    shutil.copyfile(live.__file__, tmp_path / "conftest.py")
    (tmp_path / "inkbox.py").write_text('''
import socket
from types import SimpleNamespace as NS
calls={}
events=[]
def forbidden(*a,**kw): raise AssertionError('network forbidden')
socket.create_connection=forbidden
socket.socket.connect=forbidden
class Numbers:
 def list(self): return [NS(id='source',number='+15550000001')]
class Calls:
 def list(self,*a,**kw): return list(calls.values())
 def hangup(self,call_id):
  events.append('cleanup')
  calls[call_id].status='completed'
class Texts:
 def list(self,*a,**kw): return []
 def get_conversation(self,*a,**kw): return []
 def send(self,*a,**kw): return NS(id='accepted',created_at=None)
class Inkbox:
 def __init__(self,api_key,**kw):
  assert api_key in {'synthetic-aut','synthetic-remote'}
  self.phone_numbers,self.calls,self.texts=Numbers(),Calls(),Texts()
 def __enter__(self): return self
 def __exit__(self,*a): pass
''')
    (tmp_path / "test_cross_channel.py").write_text('''
import inkbox
from types import SimpleNamespace as NS
import pytest
@pytest.fixture
def xc(live_call_cleanup):
 yield dict(remote=inkbox.Inkbox('synthetic-remote'),remote_pid='source',aut_pid='aut',remote_phone='+15550000001',aut_phone='+15550000002')
 inkbox.events.append('function_finalizer')
def _token(): return 'abcdef'
def test_sms_request_gets_email_response(xc):
 code=_token()
 xc['remote'].texts.send('source',to=xc['aut_phone'],text='code '+code)
 inkbox.events.append('original_failure')
 assert False, 'original predicate'
''')
    launcher = '''
import importlib.util,json,sys
from pathlib import Path
from types import SimpleNamespace as NS
spec=importlib.util.spec_from_file_location('channel_observer',sys.argv[1]);obs=importlib.util.module_from_spec(spec);spec.loader.exec_module(obs)
import inkbox
def observe(scope):
 assert inkbox.events==['original_failure']
 inkbox.events.append('observation')
 inkbox.calls['late']=NS(id='late',local_phone_number='+15550000001',status='answered')
 if sys.argv[2]=='true': raise RuntimeError('private diagnostic failure')
 return [{'phase':'observer','status':'unavailable'}]
obs.observe=observe
status=obs.run_tests(['test_cross_channel.py','-q','--tb=short'])
assert status==1
assert inkbox.events==['original_failure','observation','function_finalizer','cleanup']
assert inkbox.calls['late'].status=='completed'
Path('proof.json').write_text(json.dumps({'original_failure':True,'late_call_cleaned':True,'observer_raised':sys.argv[2]=='true'}))
raise SystemExit(status)
'''
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ}
    env.update(PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", OPENCLAW_INKBOX_API_KEY="synthetic-aut",
               REMOTE_INKBOX_API_KEY="synthetic-remote", INKBOX_BASE_URL="https://fixture.invalid")
    result = subprocess.run([sys.executable, "-c", launcher, str(Path(obs.__file__).resolve()), str(observer_raises).lower()],
                            cwd=tmp_path, env=env, text=True, capture_output=True, timeout=20)
    assert result.returncode == 1 and "original predicate" in result.stdout
    assert json.loads((tmp_path / "proof.json").read_text()) == {
        "original_failure": True, "late_call_cleaned": True, "observer_raised": observer_raises}
    assert "private diagnostic failure" not in result.stdout + result.stderr
