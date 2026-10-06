"""Offline observer contracts; no real credentials or model requests."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from uuid import UUID

import pytest
import hosted_sms_diagnostics as obs


def test_projection_rejects_unknown_and_private_fields():
    assert obs.safe_record({"phase": [], "status": "observed"}) is None
    assert obs.safe_record({"phase": "tool", "status": "observed", "tool": "secret tool", "text": "private",
                            "id": "private", "phone": "private", "count": True, "ordinal": 100000,
                            "scope_verified": True}) == {"phase": "tool", "status": "observed", "scope_verified": True}


def test_trace_bounds_and_reprojects_tampering(tmp_path, capsys):
    trace = obs.Trace(tmp_path / "safe.json")
    for _ in range(200):
        trace.emit("sdk", "accepted", text="private", unique_accepted=1)
    assert len(trace.records) == 128 and trace.records[-1]["truncated"]
    trace.flush()
    records = json.loads((tmp_path / "safe.json").read_text())
    records[0]["id"] = "private"
    (tmp_path / "safe.json").write_text(json.dumps(records))
    obs.report([tmp_path / "safe.json", tmp_path / "missing"])
    output = capsys.readouterr().out
    assert "private" not in output and '"status":"unavailable"' in output


def module_fixture():
    calls = []
    row = NS(id="new", created_at=datetime(2026, 1, 2, tzinfo=timezone.utc), text="maple cloud river")
    rows = [row]
    def record(name, result):
        def run(*args, **kwargs):
            calls.append((name, args, kwargs))
            return result
        return run
    expected = {"actions": object(), "settlement": object()}
    module = NS(_wait_for_open_post_call_action=record("actions", expected["actions"]),
                _wait_hosted_sms_settlement=record("settlement", expected["settlement"]),
                _expected=expected,
                _outbound_texts_to=record("texts", rows), HOSTED_POST_CALL_MARKER="maple cloud river",
                _message_created_at=lambda x: x.created_at, _voice_marker_key=lambda x: x.replace(" ", "").lower())
    return module, calls, rows


def test_wrappers_preserve_exact_args_results_and_scope():
    module, calls, rows = module_fixture()
    originals = vars(module).copy()
    scope = {}
    restore = obs.install_test_observers(module, scope)
    aut, progress, before = object(), {}, {"old"}
    watermark = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert module._wait_for_open_post_call_action(aut, "call", "maple cloud river", 99, progress) is module._expected["actions"]
    result = module._wait_hosted_sms_settlement(aut, "number", "target", before, watermark, "call", 220, progress)
    assert result is module._expected["settlement"]
    assert module._outbound_texts_to(aut, "number", "target") is rows
    assert calls == [
        ("actions", (aut, "call", "maple cloud river", 99, progress), {}),
        ("settlement", (aut, "number", "target", before, watermark, "call", 220, progress), {}),
        ("texts", (aut, "number", "target"), {}),
    ]
    assert calls[1][1][3] is before and calls[1][1][4] is watermark and calls[1][1][-1] is progress
    assert scope["rows"]["count"] == 1 and scope["rows"]["distinct"] == 1
    assert "new" not in json.dumps(scope["rows"])
    restore()
    assert module._outbound_texts_to is originals["_outbound_texts_to"]


def test_wrappers_preserve_original_exception_and_foreign_scope():
    module, calls, rows = module_fixture()
    error = RuntimeError("private original")
    def raising(*_args):
        raise error
    module._wait_for_open_post_call_action = raising
    scope = {}
    restore = obs.install_test_observers(module, scope)
    with pytest.raises(RuntimeError) as caught:
        module._wait_for_open_post_call_action(object(), "call", "marker")
    assert caught.value is error
    assert module._outbound_texts_to(object(), "foreign", "foreign") is rows
    assert "rows" not in scope
    restore()


@pytest.mark.parametrize("created,ended,expected", [
    ("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", "before"),
    ("2026-01-01T00:00:01Z", "2026-01-01T00:00:01Z", "at_or_after"),
    (None, "2026-01-01T00:00:01Z", "unavailable"),
    ("2026-01-01T00:00:01Z", None, "unavailable"),
])
def test_terminal_relation_is_fixed_enum(created, ended, expected):
    assert obs.relation(created, ended) == expected


def test_real_published_sdk_call_and_tool_envelopes_are_scoped_and_private(monkeypatch):
    from inkbox import Inkbox
    import httpx
    call_id = "00000000-0000-0000-0000-000000000001"
    seen = []
    def handle(request):
        seen.append((request.method, request.url.path))
        if request.url.path.endswith("/tool-invocations"):
            return httpx.Response(200, json={"items": [{"id": "00000000-0000-0000-0000-000000000002", "call_id": call_id,
                "tool_name": "send_sms", "status": "succeeded", "result": {"text": "private", "error_code": None},
                "started_at": "2026-01-01T00:00:00Z", "completed_at": "2026-01-01T00:00:01Z"}], "limit": 50, "offset": 0, "has_more": False})
        return httpx.Response(200, json={"id": call_id, "phone_number_id": "00000000-0000-0000-0000-000000000003",
            "direction": "outbound", "local_phone_number": "+15550000001", "remote_phone_number": "+15550000002", "status": "completed",
            "client_websocket_url": None, "use_inkbox_tts": None, "use_inkbox_stt": None, "hangup_reason": "local",
            "started_at": "2026-01-01T00:00:00Z", "ended_at": "2026-01-01T00:00:02Z", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:02Z"})
    original = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(handle)}))
    trace = obs.Trace()
    obs.read_current_call({"call_id": call_id, "rows": {"count": 2, "distinct": 2, "created": ["2026-01-01T00:00:01Z", "2026-01-01T00:00:03Z"], "truncated": False}}, trace,
                          lambda: Inkbox(api_key="synthetic", base_url="https://fixture.invalid"))
    assert len(seen) == 2 and all(method == "GET" for method, _ in seen)
    assert [r["terminal_relation"] for r in trace.records if r["phase"] == "row"] == ["before", "at_or_after"]
    assert next(r for r in trace.records if r["phase"] == "tool")["tool"] == "send_sms"
    assert not any(token in json.dumps(trace.records) for token in (call_id, "private", "+1555", "2026-"))


def test_foreign_or_missing_call_never_means_zero_activity():
    class Client:
        calls = NS(get=lambda _id: NS(id="foreign"), tool_invocations=lambda *_a, **_k: pytest.fail("foreign read"))
        def __enter__(self): return self
        def __exit__(self, *_a): return False
    trace = obs.Trace()
    obs.read_current_call({"call_id": "current"}, trace, Client)
    assert trace.records == [{"phase": "observer", "status": "unavailable"}]


def test_bounded_child_reprojects_and_rejects_invalid_output():
    trace = obs.Trace()
    obs.read_bounded({"call_id": "scope"}, trace, command=[sys.executable, "-c", 'print(\'[ {"phase":"tool","status":"observed","tool":"send_sms","id":"private"} ]\')'])
    assert trace.records == [{"phase": "tool", "status": "observed", "tool": "send_sms"}]
    trace = obs.Trace()
    obs.read_bounded({"call_id": "scope"}, trace, command=[sys.executable, "-c", 'print("x"*100000)'])
    assert trace.records == [{"phase": "observer", "status": "unavailable"}]
    # A complete bounded page is 1 scope + 1 summary + 8 rows + 50 tools + 1 page.
    class Client:
        calls = NS(get=lambda _id: NS(id="current", ended_at=None),
                   tool_invocations=lambda *_a, **_k: NS(items=[NS(call_id="current", tool_name="send_sms", status="succeeded", result={}, completed_at=None, started_at=None)] * 50, has_more=True))
        def __enter__(self): return self
        def __exit__(self, *_a): return False
    page = obs.Trace()
    obs.read_current_call({"call_id": "current", "rows": {"count": 8, "distinct": 8, "created": [None] * 8, "truncated": False}}, page, Client)
    assert len(page.records) == 61
    trace = obs.Trace()
    obs.read_bounded({"call_id": "current"}, trace, command=[sys.executable, "-c", "print(" + repr(json.dumps(page.records)) + ")"])
    assert trace.records == page.records
    trace = obs.Trace()
    obs.read_bounded({"call_id": "current"}, trace, command=[sys.executable, "-c", "print(" + repr(json.dumps(page.records + [page.records[-1]])) + ")"])
    assert trace.records == [{"phase": "observer", "status": "unavailable"}]


def test_timeout_kills_and_reaps_child_after_handshake(tmp_path):
    pidfile = tmp_path / "pid"
    code = "import os,time,pathlib;pathlib.Path(" + repr(str(pidfile)) + ").write_text(str(os.getpid()));time.sleep(30)"
    trace = obs.Trace()
    obs.read_bounded({"call_id": "scope"}, trace, timeout=3, command=[sys.executable, "-c", code])
    assert pidfile.exists()
    with pytest.raises(ProcessLookupError): os.kill(int(pidfile.read_text()), 0)
    assert trace.records == [{"phase": "observer", "status": "unavailable"}]


def test_original_pytest_failure_and_finally_are_preserved(tmp_path):
    test = tmp_path / "test_original.py"
    cleanup = tmp_path / "cleanup"
    test.write_text("from pathlib import Path\nimport os\nHOSTED_POST_CALL_MARKER='maple cloud river'\ndef _wait_for_open_post_call_action(*a,**k): pass\ndef _wait_hosted_sms_settlement(*a,**k): pass\ndef _outbound_texts_to(*a,**k): return []\ndef test_outbound_call_hosted_and_settles_sms_once():\n try:\n  assert not any(key in os.environ for key in ('OPENCLAW_INKBOX_API_KEY','REMOTE_INKBOX_API_KEY','OPENAI_API_KEY','LIVE_REAL_MODEL'))\n  _wait_hosted_sms_settlement(object(),'number','target',set(),None,'call',220,{})\n  assert False, 'original predicate'\n finally: Path(" + repr(str(cleanup)) + ").write_text('done')\n")
    # This helper also runs within live CI: never let its synthetic call scope
    # inherit the AUT/driver/model credentials or LIVE selection environment.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
           "TMPDIR": str(tmp_path), "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
           "PYTHONPYCACHEPREFIX": str(tmp_path / "pycache"),
           "HOSTED_SMS_TEST_DIAGNOSTICS": str(tmp_path / "diag.json")}
    result = subprocess.run([sys.executable, str(Path(obs.__file__)), "test", str(test), "-q", "-o", "cache_dir=" + str(tmp_path / "cache")], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 1 and "original predicate" in result.stdout and cleanup.read_text() == "done"
    observed = json.loads((tmp_path / "diag.json").read_text())
    assert {"phase": "observer", "status": "installed"} in observed
    assert {"phase": "case", "status": "failed"} in observed
    assert {"phase": "observer", "status": "unavailable"} in observed


def test_process_streams_are_separate_and_missing_evidence_is_unavailable(tmp_path, capsys):
    for i in range(2):
        (tmp_path / f"sdk.{i}").write_text(json.dumps([{"phase": "sdk", "status": "accepted", "unique_accepted": 1}]))
    obs.report([str(tmp_path / "sdk.*")])
    lines = [json.loads(line.split("=", 1)[1]) for line in capsys.readouterr().out.splitlines()]
    assert [row["stream"] for row in lines] == [1, 2]
    assert all(row["unique_accepted"] == 1 for row in lines)
    obs.report([str(tmp_path / "none.*")])
    assert '"status":"unavailable"' in capsys.readouterr().out
