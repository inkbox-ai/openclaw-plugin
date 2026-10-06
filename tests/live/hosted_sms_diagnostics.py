"""CI-only hosted-send evidence. Never changes a task result or emits private data."""
from __future__ import annotations

import json
import re
import stat
import glob
import itertools
import os
from pathlib import Path
import selectors
import time
import subprocess
import sys
from datetime import datetime, timezone

PHASES = {"observer", "case", "rows", "row", "tool", "sdk", "contact"}
STATUSES = {"installed", "observed", "passed", "failed", "unavailable", "accepted", "rejected", "threw"}
ENUMS = {
    "tool_admission": {"unknown"}, "catalog_availability": {"unknown"},
    "sdk_result": {"unknown"}, "model_completion": {"unknown"},
    "target_basis": {"request", "response", "unavailable"},
    "tool": {"send_sms", "send_imessage", "register_post_call_action", "edit_post_call_action", "delete_post_call_action", "other"},
    "tool_status": {"started", "succeeded", "failed", "other"},
    "terminal_relation": {"before", "at_or_after", "unavailable"},
    "error_code": {"none", "permission_denied", "not_found", "invalid_arguments", "already_started", "other"},
}
BOOLS = {"log_available", "scope_ambiguous", "test_marker_observed", "bridge_ready_observed", "hd_audio_observed", "bridge_closed_observed", "contact_completion_observed", "other_call_completion_observed", "scope_verified", "has_more", "truncated", "created_time_present", "marker_matches", "target_known", "target_matches", "accepted_id_present", "same_id_as_prior", "id_tracking_available", "module_bound", "original_promise"}
COUNTS = {"list_completions": 8, "lookup_completions": 8, "stream": 16, "count": 200, "distinct": 200, "ordinal": 128, "unique_accepted": 128}


def safe_record(value):
    if not isinstance(value, dict) or not isinstance(value.get("phase"), str) or not isinstance(value.get("status"), str) or value["phase"] not in PHASES or value["status"] not in STATUSES:
        return None
    result = {"phase": value["phase"], "status": value["status"]}
    for key, allowed in ENUMS.items():
        if isinstance(value.get(key), str) and value[key] in allowed:
            result[key] = value[key]
    for key in BOOLS:
        if type(value.get(key)) is bool:
            result[key] = value[key]
    for key, maximum in COUNTS.items():
        if type(value.get(key)) is int and 0 <= value[key] <= maximum:
            result[key] = value[key]
    return result


class Trace:
    def __init__(self, path=None):
        self.path, self.records = path, []

    def emit(self, phase, status="observed", **fields):
        try:
            record = safe_record({"phase": phase, "status": status, **fields})
            if record:
                if len(self.records) >= 128:
                    self.records.pop(8)
                    record["truncated"] = True
                self.records.append(record)
        except Exception:
            pass

    def flush(self):
        try:
            if self.path:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as stream:
                    json.dump([safe_record(row) for row in self.records], stream)
        except Exception:
            pass


def timestamp(value):
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result if result.tzinfo else result.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def relation(value, ended):
    current, boundary = timestamp(value), timestamp(ended)
    return "unavailable" if current is None or boundary is None else "before" if current < boundary else "at_or_after"


def install_test_observers(module, scope):
    """Delegate exact readers. Scope/IDs/timestamps stay in RAM or child stdin."""
    originals = {name: getattr(module, name) for name in ("_wait_for_open_post_call_action", "_wait_hosted_sms_settlement", "_outbound_texts_to")}

    def actions(aut, call_id, marker, *args, **kwargs):
        scope.update(aut=aut, call_id=str(call_id), marker=marker)
        return originals["_wait_for_open_post_call_action"](aut, call_id, marker, *args, **kwargs)

    def settlement(aut, number_id, remote_phone, before_ids, watermark, call_id, deadline, progress):
        scope.update(aut=aut, number_id=number_id, remote_phone=remote_phone, before_ids=before_ids,
                     watermark=watermark, call_id=str(call_id), marker=module.HOSTED_POST_CALL_MARKER)
        return originals["_wait_hosted_sms_settlement"](aut, number_id, remote_phone, before_ids, watermark, call_id, deadline, progress)

    def texts(aut, number_id, remote_phone):
        rows = originals["_outbound_texts_to"](aut, number_id, remote_phone)
        try:
            if aut is scope.get("aut") and number_id == scope.get("number_id") and remote_phone == scope.get("remote_phone") and scope.get("marker"):
                # Original reader is a concrete list limited to 200 API rows.
                matching = [row for row in rows[:200] if row.id not in scope["before_ids"]
                            and (created := module._message_created_at(row)) is not None
                            and created >= scope["watermark"]
                            and module._voice_marker_key(scope["marker"]) in module._voice_marker_key(getattr(row, "text", "") or "")]
                scope["rows"] = {"count": len(matching), "distinct": len({str(row.id) for row in matching}),
                                 "created": [module._message_created_at(row).isoformat() for row in matching[:8]],
                                 "truncated": len(matching) > 8 or len(rows) > 200}
        except Exception:
            scope["rows_unavailable"] = True
        return rows

    replacements = dict(zip(originals, (actions, settlement, texts)))
    try:
        for name, fn in replacements.items():
            setattr(module, name, fn)
    except Exception:
        for name, fn in originals.items():
            setattr(module, name, fn)
        raise

    def restore():
        for name, fn in originals.items():
            setattr(module, name, fn)
    return restore


def read_current_call(scope, trace, client_factory=None):
    """Read only the captured AUT call, after original task and cleanup finished."""
    try:
        call_id = scope.get("call_id")
        if not isinstance(call_id, str) or not call_id or len(call_id) > 128:
            raise ValueError("scope unavailable")
        if client_factory is None:
            from inkbox import Inkbox
            def client_factory():
                return Inkbox(api_key=os.environ["OPENCLAW_INKBOX_API_KEY"],
                              base_url=os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai"), timeout=2)
        with client_factory() as client:
            call = client.calls.get(call_id)
            if str(call.id) != call_id:
                raise ValueError("foreign response")
            ended = getattr(call, "ended_at", None)
            trace.emit("observer", scope_verified=True)
            rows = scope.get("rows")
            if isinstance(rows, dict) and not scope.get("rows_unavailable"):
                trace.emit("rows", count=rows.get("count"), distinct=rows.get("distinct"), truncated=rows.get("truncated"))
                for ordinal, created in enumerate(rows.get("created", [])[:8], 1):
                    trace.emit("row", ordinal=ordinal, created_time_present=timestamp(created) is not None,
                               terminal_relation=relation(created, ended))
            else:
                trace.emit("rows", "unavailable")
            # One bounded page; SDK connection retries remain inside child wall bound.
            page = client.calls.tool_invocations(call_id, limit=50)
            for ordinal, item in enumerate(page.items[:50], 1):
                if str(item.call_id) != call_id:
                    trace.emit("tool", "unavailable", scope_verified=False)
                    continue
                name = item.tool_name if item.tool_name in ENUMS["tool"] else "other"
                status = str(getattr(item.status, "value", item.status))
                code = (item.result or {}).get("error_code")
                trace.emit("tool", ordinal=ordinal, scope_verified=True, tool=name,
                           tool_status=status if status in ENUMS["tool_status"] else "other",
                           terminal_relation=relation(item.completed_at or item.started_at, ended),
                           error_code="none" if code is None else code if isinstance(code, str) and code in ENUMS["error_code"] else "other")
            trace.emit("observer", count=min(len(page.items), 200), has_more=page.has_more is True)
    except Exception:
        trace.emit("observer", "unavailable")


def read_bounded(scope, trace, *, timeout=8, command=None):
    """Hard kill/reap wall bound; no raw child output/error is ever relayed."""
    try:
        if not scope.get("call_id"):
            raise ValueError("scope unavailable")
        payload = {key: scope[key] for key in ("call_id", "rows", "rows_unavailable") if key in scope}
        # Bounded pipe reads, not communicate(capture_output), bound even a noisy child.
        child = subprocess.Popen(command or [sys.executable, str(Path(__file__).resolve()), "read"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            child.stdin.write(json.dumps(payload).encode())
            child.stdin.close()
            deadline, output = time.monotonic() + timeout, bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError("observer timeout")
                    data = os.read(child.stdout.fileno(), min(4096, 65_537 - len(output)))
                    if not data:
                        break
                    output.extend(data)
                    if len(output) > 65_536:
                        raise ValueError("observer output limit")
            if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise ValueError("observer unavailable")
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()
        records = json.loads(output)
        if not isinstance(records, list) or not 1 <= len(records) <= 61:
            raise ValueError("invalid observation")
        cleaned = [safe_record(row) for row in records]
        if any(row is None or row["phase"] not in {"observer", "rows", "row", "tool"} for row in cleaned):
            raise ValueError("invalid observation")
        for row in cleaned:
            trace.emit(**row)
    except Exception:
        trace.emit("observer", "unavailable")



def install_contact_observer(module, scope):
    """Capture only the exact original predicate's scope; never change its call."""
    original = module._gateway_has_direct_contact_read

    def observe(*args, **kwargs):
        result = original(*args, **kwargs)
        try:
            call_id = args[1] if len(args) > 1 else kwargs.get("call_id")
            call_id = str(call_id)
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", call_id):
                scope["ambiguous"] = True
            elif scope.get("call_id", call_id) != call_id:
                scope["ambiguous"] = True
            else:
                scope["call_id"] = call_id
                if type(result) is bool:
                    scope["test_marker_observed"] = result
        except Exception:
            scope["ambiguous"] = True
        return result

    module._gateway_has_direct_contact_read = observe
    return lambda: setattr(module, "_gateway_has_direct_contact_read", original)


def contact_message(line):
    """Accept only the native channel logger's complete, anchored envelopes."""
    if len(line.encode("utf-8")) > 32768:
        return None
    try:
        row = json.loads(line)
        if isinstance(row, dict) and row.get("subsystem") == "channels/inkbox" and row.get("level") == "info" and isinstance(row.get("message"), str):
            return row["message"]
        return None
    except Exception:
        # Native pretty/compact output strips the redundant leading 'Inkbox'.
        clean = re.sub(r"\x1b\[[0-9;]*m", "", line)
        match = re.fullmatch(r"(?:(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})) )?\[inkbox\] (.+)", clean)
        return match[1] if match else None


def read_contact_log(scope, trace, path=None):
    """Failure-only bounded file read; no runtime/API/config/session access."""
    fields = dict(tool_admission="unknown", catalog_availability="unknown", sdk_result="unknown", model_completion="unknown")
    try:
        call_id = scope.get("call_id")
        if scope.get("ambiguous") or not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", call_id):
            raise ValueError()
        fd = os.open(path or os.environ["GATEWAY_LOG"], os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError()
            start = max(0, info.st_size - 2 * 1024 * 1024)
            stream.seek(start)
            raw = stream.read(2 * 1024 * 1024)
        if start:
            raw = raw.partition(b"\n")[2]
        # Only physical LF records: Unicode separators inside messages cannot
        # promote a fragment of another subsystem's text into a new envelope.
        lines = [line.decode("utf-8", errors="replace").removesuffix("\r") for line in raw.split(b"\n")]
        fields.update(log_available=True, scope_verified=True, scope_ambiguous=False,
                      truncated=start > 0 or len(lines) > 8192,
                      bridge_ready_observed=False, hd_audio_observed=False, bridge_closed_observed=False,
                      contact_completion_observed=False, other_call_completion_observed=False,
                      list_completions=0, lookup_completions=0)
        if type(scope.get("test_marker_observed")) is bool:
            fields["test_marker_observed"] = scope["test_marker_observed"]
        for line in lines[-8192:]:
            message = contact_message(line)
            if message is None:
                continue
            message = re.sub(r"^Inkbox ", "", message)
            marker = re.fullmatch(r"realtime direct contact read inkbox_(list_contacts|lookup_contact) for call_id=([A-Za-z0-9_-]{1,128})", message)
            if marker:
                if marker[2] != call_id:
                    fields["other_call_completion_observed"] = True
                else:
                    fields["contact_completion_observed"] = True
                    key = "list_completions" if marker[1] == "list_contacts" else "lookup_completions"
                    fields[key] = min(8, fields[key] + 1)
                continue
            if re.fullmatch(r"realtime bridge ready: call_id=" + re.escape(call_id) + r" provider=[A-Za-z0-9_-]+", message):
                fields["bridge_ready_observed"] = True
            if message == f"realtime audio negotiated: call_id={call_id} format=pcm_s16le_16000":
                fields["hd_audio_observed"] = True
            if re.fullmatch(r"realtime bridge closed: call_id=" + re.escape(call_id) + r" reason=(?:completed|error)", message):
                fields["bridge_closed_observed"] = True
        # Observed means a supported current-call envelope, never model success.
        observed = any(fields[key] for key in ("bridge_ready_observed", "hd_audio_observed", "bridge_closed_observed", "contact_completion_observed"))
        trace.emit("contact", "observed" if observed else "unavailable", **fields)
    except Exception:
        fields.setdefault("scope_ambiguous", scope.get("ambiguous") is True)
        trace.emit("contact", "unavailable", **fields)

def run_tests(args):
    import pytest

    class Observer:
        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_call(self, item):
            contact = item.name == "test_outbound_call_realtime_direct_contact_lookup"
            if not contact and item.name != "test_outbound_call_hosted_and_settles_sms_once":
                yield
                return
            trace, scope, restore = Trace(os.environ.get("HOSTED_SMS_TEST_DIAGNOSTICS")), {}, None
            try:
                restore = (install_contact_observer if contact else install_test_observers)(item.module, scope)
                trace.emit("observer", "installed")
            except Exception:
                trace.emit("observer", "unavailable")
            outcome = yield  # Original exception is never caught/replaced/forced successful.
            try:
                if restore:
                    restore()
                trace.emit("case", "failed" if outcome.excinfo else "passed")
                if outcome.excinfo:
                    if contact:
                        read_contact_log(scope, trace)
                    else:
                        read_bounded(scope, trace)
            except Exception:
                trace.emit("observer", "unavailable")
            finally:
                trace.flush()

    return pytest.main(args, plugins=[Observer()])


def report(paths):
    # SDK preload children have separate RAM/ID sets and separate files. Never
    # aggregate them into a misleading cross-process distinct-message count.
    def expand(path):
        path = str(path)
        if not glob.has_magic(path):
            yield path
            return
        matches = glob.iglob(path)
        first = next(matches, None)
        yield first  # Missing SDK stream is explicitly unavailable, never zero.
        if first is not None:
            yield from matches
    streams = itertools.chain.from_iterable(expand(path) for path in paths)
    seen = 0
    for ordinal, path in enumerate(itertools.islice(streams, 17), 1):
        if ordinal > 16:
            print('hosted_sms_observation={"phase":"observer","status":"unavailable","truncated":true}')
            break
        seen += 1
        try:
            with open(path) as stream:
                raw = stream.read(65_537)
            if len(raw) > 65_536:
                raise ValueError("oversize")
            records = json.loads(raw)
            if not isinstance(records, list) or len(records) > 128:
                raise ValueError("invalid records")
            for record in records:
                clean = safe_record(record)
                if clean:
                    clean["stream"] = ordinal
                    print("hosted_sms_observation=" + json.dumps(clean, sort_keys=True))
        except Exception:
            print('hosted_sms_observation={"phase":"observer","status":"unavailable"}')
    if not seen:
        print('hosted_sms_observation={"phase":"observer","status":"unavailable"}')


if __name__ == "__main__":
    if sys.argv[1:2] == ["test"]:
        raise SystemExit(run_tests(sys.argv[2:]))
    if sys.argv[1:2] == ["read"]:
        trace = Trace()
        try:
            scope = json.loads(sys.stdin.read(65_537))
            read_current_call(scope, trace)
        except Exception:
            trace.emit("observer", "unavailable")
        print(json.dumps(trace.records))
    elif sys.argv[1:2] == ["report"]:
        report(sys.argv[2:])
