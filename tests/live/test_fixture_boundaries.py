"""Credential-free tests of live fixture admission and reset receipt readiness."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace as NS

import pytest

import conftest as live


def _env(directory):
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ}
    env.update(PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=str(directory), OPENCLAW_INKBOX_API_KEY="synthetic-aut",
               REMOTE_INKBOX_API_KEY="synthetic-remote", INKBOX_BASE_URL="https://fixture.invalid")
    return env


def test_boundary_matches_actual_pytest_collection_of_live_modules(tmp_path):
    directory = Path(live.__file__).resolve().parent
    env = _env(directory)
    env.pop("OPENCLAW_INKBOX_API_KEY")
    env.pop("REMOTE_INKBOX_API_KEY")
    result = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
                             *live.LIVE_CASES], cwd=directory, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    collected = {}
    for line in result.stdout.splitlines():
        if ".py::test_" in line:
            file, name = line.strip().split("::", 1)
            collected.setdefault(Path(file).name, set()).add(name.split("[", 1)[0])
    assert collected == live.LIVE_CASES
    assert "test_email_reachability" in collected["test_email_reply.py"]
    assert "test_sms_reachability" in collected["test_sms.py"]


def test_helper_or_foreign_same_named_case_is_not_live():
    directory = Path(live.__file__).resolve().parent
    assert not live._is_live_case(NS(path=directory / "test_fixture_boundaries.py", name="test_sms_reachability"))
    assert not live._is_live_case(NS(path=directory.parent / "test_sms.py", name="test_sms_reachability"))
    assert not live._is_live_case(NS(path=directory / "test_sms.py", name="test_new_unregistered_helper"))
    assert live._is_live_case(NS(path=directory / "test_sms.py", name="test_sms_reachability[param]",
                                originalname="test_sms_reachability"))


_SDK = r'''
import atexit,json,os,socket
from datetime import datetime,timezone
from pathlib import Path
from types import SimpleNamespace as NS
events=[]
calls={'preexisting':NS(id='preexisting',local_phone_number='+15550000001',status='answered',created_at=datetime.now(timezone.utc))}
def forbidden(*a,**kw): raise AssertionError('network is forbidden')
socket.create_connection=forbidden
socket.socket.connect=forbidden
class Texts:
 def get_conversation(self,*a,**kw): return self.list(*a,**kw)
 def list(self,*a,**kw):
  events.append('texts_list')
  if os.environ.get('RESET_OUTCOME'):
   return [NS(direction='outbound',remote_phone_number='+15550000001',created_at=datetime.now(timezone.utc))]*7
  return []
 def send(self,*a,**kw):
  events.append('send')
  if os.environ.get('RESET_OUTCOME')=='queued': return NS(id='accepted',created_at=datetime.now(timezone.utc))
  raise AssertionError('synthetic rejected reset')
class Numbers:
 def __init__(self,role): self.role=role
 def list(self): events.append('numbers_list'); return [NS(id=self.role,number='+15550000001' if self.role=='aut' else '+15550000002')]
class Calls:
 def list(self,*a,**kw): events.append('calls_list'); return list(calls.values())
 def hangup(self,call_id): events.append('hangup_'+call_id); calls[call_id].status='completed'
class Inkbox:
 def __init__(self,api_key,**kw):
  assert api_key in {'synthetic-aut','synthetic-remote'}
  events.append('client_create'); role=api_key.removeprefix('synthetic-')
  self.phone_numbers,self.texts,self.calls=Numbers(role),Texts(),Calls()
 def __enter__(self): return self
 def __exit__(self,*a): events.append('client_close')
atexit.register(lambda:Path('evidence.json').write_text(json.dumps(events)))
'''


@pytest.mark.parametrize("with_live_case", [False, True])
def test_actual_pytest_helpers_make_no_sdk_calls_and_live_cases_keep_cleanup(tmp_path, with_live_case):
    shutil.copyfile(live.__file__, tmp_path / "conftest.py")
    (tmp_path / "inkbox.py").write_text(_SDK)
    (tmp_path / "test_helpers.py").write_text("import inkbox\ndef test_offline(): assert inkbox.events == []\n")
    files = ["test_helpers.py"]
    if with_live_case:
        (tmp_path / "test_sms.py").write_text('''
import inkbox
from types import SimpleNamespace as NS
def test_sms_reachability():
 assert inkbox.events.count('texts_list') == 1
 inkbox.calls['new']=NS(id='new',local_phone_number='+15550000001',status='answered')
''')
        (tmp_path / "test_email_reply.py").write_text('''
import inkbox
def test_email_reachability(): assert inkbox.events.count('texts_list') == 2
''')
        files += ["test_sms.py", "test_email_reply.py"]
    result = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *files],
                             cwd=tmp_path, env=_env(tmp_path), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    events = json.loads((tmp_path / "evidence.json").read_text())
    if not with_live_case:
        assert events == []
    else:
        assert events.count("client_create") == 3  # cached cleanup + two reset clients
        assert events.count("texts_list") == 2
        assert events.count("hangup_new") == 1 and "hangup_preexisting" not in events
        assert "send" not in events
        assert events.count("client_close") == 2


@pytest.mark.parametrize("outcome", ["queued", "rejected"])
def test_failed_reset_setup_never_enters_model_case_and_keeps_final_cleanup(tmp_path, outcome):
    # Only the disposable fixture's setup clock is shortened; no model task or
    # production deadline is changed. Exercise pytest's real setup/finalizers.
    (tmp_path / "conftest.py").write_text(Path(live.__file__).read_text() +
        "\nRESET_SETUP_TIMEOUT_S = .04\nRESET_POLL_S = .005\n")
    (tmp_path / "inkbox.py").write_text(_SDK)
    (tmp_path / "test_sms.py").write_text('''
from pathlib import Path
def test_sms_reachability(): Path('model-entered').write_text('unexpected')
''')
    env = _env(tmp_path)
    env["RESET_OUTCOME"] = outcome
    result = subprocess.run([sys.executable, "-m", "pytest", "test_sms.py", "-q", "--tb=short", "-p", "no:cacheprovider"],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 1 and "ERROR" in result.stdout
    assert not (tmp_path / "model-entered").exists()
    events = json.loads((tmp_path / "evidence.json").read_text())
    assert events.count("send") == 1
    assert events.count("calls_list") == 4  # baseline, stale scan, final scan, settlement
    assert events.count("client_close") == 2
    assert "hangup_preexisting" not in events
    assert "synthetic rejected reset" not in result.stdout


class Clock:
    def __init__(self): self.now = 0
    def monotonic(self): return self.now
    def sleep(self, duration): self.now += duration


def _scenario(monkeypatch, *, opener="penetrator", outcome="delayed"):
    clock = Clock()
    monkeypatch.setattr(live.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(live.time, "sleep", clock.sleep)
    monkeypatch.setattr(live, "_sync_body", lambda: "synthetic-current-reset")
    created = datetime(2026, 10, 6, tzinfo=timezone.utc)
    sender_phone, receiver_phone = ("+15550000001", "+15550000002") if opener == "penetrator" else ("+15550000002", "+15550000001")
    writes, reads = [], []
    old = [NS(id=f"out-{i}", direction="outbound", remote_phone_number=sender_phone, created_at=created-timedelta(seconds=i+1)) for i in range(7)]
    def receipt():
        return NS(id="received", direction="inbound", local_phone_number=receiver_phone,
                  remote_phone_number=sender_phone, text="synthetic-current-reset", created_at=created)
    def send(*args, **kwargs):
        writes.append((args, kwargs))
        if outcome == "rejected": raise RuntimeError("private error with credentials")
        return NS(id="accepted", created_at=created)
    def rows(*args, **kwargs):
        reads.append((args, kwargs))
        if outcome == "unknown": raise RuntimeError("private history")
        if outcome == "healthy": return []
        if not writes: return old
        if outcome == "read_failure": raise RuntimeError("private receipt")
        if outcome == "queued" or (outcome == "delayed" and clock.now == 0): return old
        current = receipt()
        if outcome == "wrong_sender": current.remote_phone_number = "+15559999999"
        if outcome == "wrong_receiver": current.local_phone_number = "+15559999999"
        if outcome == "old_body": current.text = "old-reset"
        if outcome == "old_time": current.created_at -= timedelta(days=1)
        if outcome == "duplicate": return [current, receipt()]
        if outcome == "full_page": return [current] + old * 4 + [old[0]]
        if outcome == "still_low" and "start_datetime" not in kwargs:
            return [NS(**{**vars(row), "created_at": created+timedelta(seconds=1)}) for row in old] + [current]
        if outcome == "late_read": clock.now = 31
        return [current]
    sender = NS(texts=NS(send=send))
    receiver = NS(texts=NS(list=rows, get_conversation=rows))
    channel = (sender,"aut",sender_phone,receiver,"driver",receiver_phone) if opener == "penetrator" else (receiver,"aut",receiver_phone,sender,"driver",sender_phone)
    return clock, channel, writes, reads


@pytest.mark.parametrize("opener", ["penetrator", "aut"])
def test_reset_waits_for_exact_current_inbound_and_rechecks_healthy_window(monkeypatch, opener):
    clock, channel, writes, reads = _scenario(monkeypatch, opener=opener)
    live._ensure_conversation_health(channel, opener, 30)
    assert clock.now == .5
    assert len(writes) == 1
    assert len(reads) == 4  # initial window, no receipt, receipt, refreshed window
    assert "start_datetime" in reads[1][1] and "start_datetime" not in reads[-1][1]


@pytest.mark.parametrize("outcome,send_count", [("healthy",0), ("unknown",0), ("rejected",1),
    ("queued",1), ("wrong_sender",1), ("wrong_receiver",1), ("old_body",1), ("old_time",1),
    ("duplicate",1), ("full_page",1), ("still_low",1), ("read_failure",1), ("late_read",1)])
def test_reset_never_replays_or_claims_unconfirmed_readiness(monkeypatch, outcome, send_count):
    clock, channel, writes, reads = _scenario(monkeypatch, outcome=outcome)
    if outcome == "healthy":
        live._ensure_conversation_health(channel, "penetrator", 30)
    else:
        with pytest.raises(RuntimeError) as error:
            live._ensure_conversation_health(channel, "penetrator", 30)
        assert "private" not in str(error.value)
    assert len(writes) == send_count
    assert len(reads) <= 1 + live.RESET_MAX_POLLS * 2
    assert clock.now <= 31  # simulated final request overrun cannot start another operation


def test_expired_setup_budget_prevents_reads_and_send(monkeypatch):
    _, channel, writes, reads = _scenario(monkeypatch)
    with pytest.raises(RuntimeError, match="setup budget"):
        live._ensure_conversation_health(channel, "penetrator", 0)
    assert writes == reads == []


def test_foreign_conversation_rows_never_claim_free_window():
    rows = [NS(direction="outbound", remote_phone_number="+15559999999", created_at="now")] * 30
    assert live._window_count(NS(texts=NS(get_conversation=lambda *a, **kw: rows)), "number", "+15550000001") is None


def test_actual_sdk_window_cannot_be_hidden_by_unrelated_global_traffic(monkeypatch):
    import httpx
    from inkbox import Inkbox
    number_id = "00000000-0000-0000-0000-000000000001"
    calls = []
    def row(counterparty):
        return dict(id="00000000-0000-0000-0000-000000000002", direction="outbound",
                    local_phone_number="+15550000002", remote_phone_number=counterparty, text="synthetic",
                    type="sms", is_read=False, created_at="2026-10-06T18:00:00+00:00",
                    updated_at="2026-10-06T18:00:00+00:00", delivery_status="queued")
    def handle(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        if request.url.path.endswith("/texts/conversations/+15550000001"):
            return httpx.Response(200, json=[row("+15550000001")] * 7)
        # A global last-page lookup would miss the target's full window.
        return httpx.Response(200, json=[row("+15559999999")] * 30)
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    with Inkbox(api_key="synthetic-not-secret", base_url="https://fixture.invalid", timeout=2) as client:
        assert live._window_count(client, number_id, "+15550000001") == 7
    assert calls == [("GET", f"/api/v1/phone/numbers/{number_id}/texts/conversations/+15550000001",
                      {"limit": "50", "offset": "0"})]


@pytest.mark.parametrize("status,detail,expected", [
    (404, "Conversation not found", 0),
    (404, "Not Found", None),
    (404, "Phone number not found", None),
    (403, "Conversation not found", None),
    (503, "Conversation not found", None),
    (404, {"detail": "Conversation not found"}, None),
])
def test_actual_sdk_first_contact_is_only_exact_missing_conversation(monkeypatch, status, detail, expected):
    import httpx
    from inkbox import Inkbox
    number_id = "00000000-0000-0000-0000-000000000001"
    calls = []
    def handle(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        return httpx.Response(status, json={"detail": detail})
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    with Inkbox(api_key="synthetic-not-secret", base_url="https://fixture.invalid", timeout=2) as client:
        assert live._window_count(client, number_id, "+15550000001", allow_first_contact=True) == expected
    assert calls == [("GET", f"/api/v1/phone/numbers/{number_id}/texts/conversations/+15550000001",
                      {"limit": "50", "offset": "0"})]


def test_actual_published_sdk_queued_send_requires_receiver_receipt(monkeypatch):
    import httpx
    from inkbox import Inkbox
    clock = Clock()
    monkeypatch.setattr(live.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(live.time, "sleep", clock.sleep)
    sender_id, receiver_id = "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
    stamp = "2026-10-06T18:00:00+00:00"
    calls, sent = [], []
    def row(inbound=False, body="old"):
        return dict(id="00000000-0000-0000-0000-000000000003", direction="inbound" if inbound else "outbound",
                    local_phone_number="+15550000002" if inbound else "+15550000001",
                    remote_phone_number="+15550000001" if inbound else "+15550000002", text=body,
                    type="sms", is_read=False, created_at=stamp, updated_at=stamp, delivery_status=None if inbound else "queued")
    def handle(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        if request.method == "POST":
            assert request.url.path == f"/api/v1/phone/numbers/{sender_id}/texts"
            sent.append(json.loads(request.content))
            return httpx.Response(200, json=row(body=sent[0]["text"]))
        assert request.url.path in {f"/api/v1/phone/numbers/{receiver_id}/texts",
                                    f"/api/v1/phone/numbers/{receiver_id}/texts/conversations/+15550000001"}
        if not sent:
            old = {**row(), "remote_phone_number": "+15550000001"}
            return httpx.Response(200, json=[old] * 7)
        if clock.now == 0:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[row(True, sent[0]["text"])])
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    with Inkbox(api_key="synthetic-aut", base_url="https://fixture.invalid", timeout=2) as aut, \
            Inkbox(api_key="synthetic-remote", base_url="https://fixture.invalid", timeout=2) as remote:
        live._ensure_conversation_health((aut,sender_id,"+15550000001",remote,receiver_id,"+15550000002"), "penetrator", 30)
    assert clock.now == .5
    assert len(sent) == 1 and sent[0]["to"] == "+15550000002"
    assert [call[0] for call in calls] == ["GET", "POST", "GET", "GET", "GET"]
    assert calls[2][2]["start_datetime"] == stamp
    assert calls[0][1].endswith("/texts/conversations/+15550000001")
    assert calls[-1][1].endswith("/texts/conversations/+15550000001")
    assert calls[0][2] == calls[-1][2] == {"limit": "50", "offset": "0"}


def test_actual_sdk_refreshed_missing_conversation_never_yields_model_case(monkeypatch):
    import httpx
    from inkbox import Inkbox
    clock = Clock()
    monkeypatch.setattr(live.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(live.time, "sleep", clock.sleep)
    monkeypatch.setattr(live, "AUT_KEY", "synthetic-aut")
    monkeypatch.setattr(live, "REMOTE_KEY", "synthetic-remote")
    sender_id, receiver_id = "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
    stamp = "2026-10-06T18:00:00+00:00"
    calls, sent, fixture_requests = [], [], []
    def row(inbound=False, body="old"):
        return dict(id="00000000-0000-0000-0000-000000000003", direction="inbound" if inbound else "outbound",
                    local_phone_number="+15550000002",
                    remote_phone_number="+15550000001", text=body, type="sms", is_read=False,
                    created_at=stamp, updated_at=stamp, delivery_status=None if inbound else "queued")
    def handle(request):
        calls.append((request.method, request.url.path))
        if request.method == "POST":
            sent.append(json.loads(request.content))
            return httpx.Response(200, json={**row(body=sent[0]["text"]),
                                               "local_phone_number": "+15550000001", "remote_phone_number": "+15550000002"})
        if request.url.path.endswith("/conversations/+15550000001"):
            if sent:
                return httpx.Response(404, json={"detail": "Conversation not found"})
            return httpx.Response(200, json=[row()] * 7)
        assert request.url.path == f"/api/v1/phone/numbers/{receiver_id}/texts"
        return httpx.Response(200, json=[row(True, sent[0]["text"])])
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    with Inkbox(api_key="synthetic-aut", base_url="https://fixture.invalid", timeout=2) as aut, \
            Inkbox(api_key="synthetic-remote", base_url="https://fixture.invalid", timeout=2) as remote:
        channel = (aut,sender_id,"+15550000001",remote,receiver_id,"+15550000002")
        monkeypatch.setattr(live, "_reset_endpoints", lambda clients, deadline: channel)
        def fixture(name):
            fixture_requests.append(name)
            return (aut, remote) if name == "_reset_channel" else None
        request = NS(node=NS(path=Path(live.__file__).parent / "test_sms.py", name="test_sms_reachability",
                             get_closest_marker=lambda _: None), getfixturevalue=fixture)
        entered = []
        with pytest.raises(RuntimeError, match="refreshed window unavailable"):
            for _ in live._reset_conversation_health.__wrapped__(request):
                entered.append("model case")
    assert entered == []
    assert fixture_requests == ["live_call_cleanup", "_reset_channel"]
    assert len(sent) == 1
    assert calls == [
        ("GET", f"/api/v1/phone/numbers/{receiver_id}/texts/conversations/+15550000001"),
        ("POST", f"/api/v1/phone/numbers/{sender_id}/texts"),
        ("GET", f"/api/v1/phone/numbers/{receiver_id}/texts"),
        ("GET", f"/api/v1/phone/numbers/{receiver_id}/texts/conversations/+15550000001"),
    ]
