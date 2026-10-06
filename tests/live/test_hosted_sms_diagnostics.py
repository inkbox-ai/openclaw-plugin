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


def test_contact_delegate_preserves_args_value_exception_and_restoration():
    calls, scope = [], {}
    value, error = object(), RuntimeError("private original")
    def original(*args, **kwargs):
        calls.append((args, kwargs))
        if kwargs.get("raise_error"):
            raise error
        return value
    module = NS(_gateway_has_direct_contact_read=original)
    restore = obs.install_contact_observer(module, scope)
    log = "private log"
    assert module._gateway_has_direct_contact_read(log, "current") is value
    assert calls == [((log, "current"), {})]
    with pytest.raises(RuntimeError) as caught:
        module._gateway_has_direct_contact_read(log, "current", raise_error=True)
    assert caught.value is error and len(calls) == 2
    restore()
    assert module._gateway_has_direct_contact_read is original


def test_contact_scope_never_retargets_to_another_call(tmp_path):
    scope = {}
    module = NS(_gateway_has_direct_contact_read=lambda *_: False)
    restore = obs.install_contact_observer(module, scope)
    assert module._gateway_has_direct_contact_read("", "first") is False
    assert module._gateway_has_direct_contact_read("", "second") is False
    trace = obs.Trace()
    obs.read_contact_log(scope, trace, tmp_path / "missing")
    assert trace.records[0]["status"] == "unavailable" and trace.records[0]["scope_ambiguous"]
    assert scope["call_id"] == "first"
    restore()


def test_contact_projection_current_and_other_call_are_not_sdk_or_model_success(tmp_path):
    path = tmp_path / "gateway"
    path.write_text("\n".join([
        "21:00:00 [inkbox] realtime bridge ready: call_id=current provider=openai",
        "[inkbox] realtime audio negotiated: call_id=current format=pcm_s16le_16000",
        '[inkbox] realtime direct contact read inkbox_list_contacts for call_id=current',
        '[inkbox] realtime direct contact read inkbox_lookup_contact for call_id=current',
        '[inkbox] realtime direct contact read inkbox_lookup_contact for call_id=foreign',
        json.dumps({"level": "info", "subsystem": "channels/inkbox", "message": "Inkbox realtime bridge closed: call_id=current reason=completed", "private": "private payload"}),
    ]))
    trace = obs.Trace()
    obs.read_contact_log({"call_id": "current", "test_marker_observed": False}, trace, path)
    row = trace.records[0]
    assert row["status"] == "observed" and row["log_available"] and not row["truncated"]
    assert all(row[k] for k in ("bridge_ready_observed", "hd_audio_observed", "bridge_closed_observed", "contact_completion_observed", "other_call_completion_observed"))
    assert row["list_completions"] == row["lookup_completions"] == 1
    assert row["test_marker_observed"] is False
    assert all(row[k] == "unknown" for k in ("tool_admission", "catalog_availability", "sdk_result", "model_completion"))
    assert not any(s in json.dumps(row) for s in ("current", "foreign", "private", "openai", "21:00"))


@pytest.mark.parametrize("line", [
    "user echo [inkbox] realtime direct contact read inkbox_list_contacts for call_id=current",
    '[agent] [inkbox] realtime direct contact read inkbox_list_contacts for call_id=current',
    '[inkbox] model said: realtime direct contact read inkbox_list_contacts for call_id=current',
    '[inkbox] realtime direct contact read inkbox_list_contacts for call_id=current-other',
    '[inkbox] realtime direct contact read inkbox_list_contacts for call_id=current extra=private',
    json.dumps({"level": "info", "subsystem": "other", "message": "Inkbox realtime direct contact read inkbox_list_contacts for call_id=current"}),
    json.dumps({"level": "error", "subsystem": "channels/inkbox", "message": "Inkbox realtime direct contact read inkbox_list_contacts for call_id=current"}),
    '[inkbox] realtime direct contact read inkbox_send_sms for call_id=current',
    '[inkbox] realtime direct contact read inkbox_list_contacts for call_id=[REDACTED]',
])
def test_contact_missing_forged_foreign_and_redacted_evidence_stays_unknown(tmp_path, line):
    path = tmp_path / "gateway"
    path.write_text(line)
    trace = obs.Trace()
    obs.read_contact_log({"call_id": "current"}, trace, path)
    row = trace.records[0]
    assert row["status"] == "unavailable" and not row["contact_completion_observed"]
    assert row["tool_admission"] == "unknown"


def test_contact_missing_file_nonregular_and_unknown_scope_are_unavailable(tmp_path):
    for scope, path in [({}, tmp_path / "missing"), ({"call_id": "current"}, tmp_path / "missing"), ({"call_id": "current"}, tmp_path)]:
        trace = obs.Trace()
        obs.read_contact_log(scope, trace, path)
        assert trace.records[0]["status"] == "unavailable"
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    trace = obs.Trace()
    obs.read_contact_log({"call_id": "current"}, trace, fifo)
    assert trace.records[0]["status"] == "unavailable"


def test_contact_tail_lines_counts_and_output_are_bounded(tmp_path, capsys):
    path = tmp_path / "gateway"
    line = '[inkbox] realtime direct contact read inkbox_list_contacts for call_id=current\n'
    path.write_text("private" * 400000 + "\n" + line * 9000)
    trace = obs.Trace(tmp_path / "safe.json")
    obs.read_contact_log({"call_id": "current"}, trace, path)
    row = trace.records[0]
    assert row["truncated"] and row["list_completions"] == 8 and row["contact_completion_observed"]
    trace.flush()
    obs.report([trace.path])
    assert "private" not in capsys.readouterr().out
    assert len(trace.path.read_bytes()) < 1024


@pytest.mark.parametrize("kind", ["failure", "observer_error", "pass", "unrelated"])
def test_contact_observer_preserves_pytest_result_and_final_cleanup(tmp_path, kind):
    name = "test_unrelated" if kind == "unrelated" else "test_outbound_call_realtime_direct_contact_lookup"
    failing = kind in {"failure", "observer_error"}
    cleanup, late = tmp_path / "cleanup", tmp_path / "late"
    test = tmp_path / "test_original.py"
    test.write_text("import pytest\nfrom pathlib import Path\ndef _gateway_has_direct_contact_read(*a,**k): return False\n@pytest.fixture(autouse=True)\ndef cleanup():\n yield\n Path(" + repr(str(cleanup)) + ").write_text('late-owned' if Path(" + repr(str(late)) + ").exists() else 'ordinary')\ndef " + name + "():\n assert _gateway_has_direct_contact_read('private','current') is False\n" + (" assert False, 'original predicate'\n" if failing else ""))
    script = "import sys,pathlib;sys.path.insert(0," + repr(str(Path(obs.__file__).parent)) + ");import hosted_sms_diagnostics as o\ndef read(*a,**k):\n pathlib.Path(" + repr(str(late)) + ").write_text('late-owned')\n" + (" raise RuntimeError('private observer error')\n" if kind == "observer_error" else " o.Trace.emit(a[1],'contact','unavailable',tool_admission='unknown')\n") + "o.read_contact_log=read\nraise SystemExit(o.run_tests(sys.argv[1:]))"
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "TMPDIR": str(tmp_path), "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTHONPYCACHEPREFIX": str(tmp_path / "pycache"), "HOSTED_SMS_TEST_DIAGNOSTICS": str(tmp_path / "diag.json")}
    result = subprocess.run([sys.executable, "-c", script, str(test), "-q", "-o", "cache_dir=" + str(tmp_path / "cache")], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == int(failing)
    assert cleanup.read_text() == ("late-owned" if failing else "ordinary")
    assert ("original predicate" in result.stdout) is failing
    assert "private observer error" not in result.stdout + result.stderr
    if kind == "unrelated":
        assert not (tmp_path / "diag.json").exists()
    else:
        rows = json.loads((tmp_path / "diag.json").read_text())
        assert {"phase": "case", "status": "failed" if failing else "passed"} in rows
        if not failing:
            assert all(row["phase"] != "contact" for row in rows)


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\u0085", "\v", "\f", "\x1e"])
def test_contact_physical_line_boundaries_cannot_create_an_envelope(tmp_path, separator):
    path = tmp_path / "gateway"
    path.write_text("[other] user content" + separator + "[inkbox] realtime direct contact read inkbox_list_contacts for call_id=current" + separator + "continued user content")
    trace = obs.Trace()
    obs.read_contact_log({"call_id": "current"}, trace, path)
    assert trace.records[0]["status"] == "unavailable"
    assert trace.records[0]["contact_completion_observed"] is False


def test_contact_deep_malformed_json_retains_an_unavailable_contact_record(tmp_path):
    path = tmp_path / "gateway"
    path.write_text("[" * 10000)
    trace = obs.Trace()
    obs.read_contact_log({"call_id": "current"}, trace, path)
    assert len(trace.records) == 1
    assert trace.records[0]["phase"] == "contact" and trace.records[0]["status"] == "unavailable"
    assert trace.records[0]["tool_admission"] == "unknown"
