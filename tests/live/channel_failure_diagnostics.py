"""Exact-case, post-outcome CI evidence; never changes the original model task."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

CASE = "test_sms_request_gets_email_response"
MODULE = "test_cross_channel"
MAX_REQUESTS = 4
MAX_TEXT = 16_384
ENUMS = {
    "phase": {"observer", "source", "inbound", "native"},
    "status": {"observed", "unavailable"},
    "delivery": {"queued", "sent", "delivered", "delivery_failed", "delivery_unconfirmed",
                 "sending_failed", "blocked_spam_filter", "unknown"},
    "transcript": {"unknown"},
    "tool_evidence": {"unavailable"},
    "model_start": {"unknown"},
    "completion": {"unknown"},
}
BOOLS = {"accepted", "scope_verified", "sent", "delivered", "failed", "page_full", "ambiguous", "truncated", "ingress_observed"}
COUNTS = {"ordinal": MAX_REQUESTS, "matches": 50, "requests": MAX_REQUESTS}


def safe_record(value):
    if not isinstance(value, dict):
        return None
    if not all(isinstance(value.get(k), str) and value[k] in ENUMS[k] for k in ("phase", "status")):
        return None
    result = {"phase": value["phase"], "status": value["status"]}
    for key, choices in ENUMS.items():
        if isinstance(value.get(key), str) and value[key] in choices:
            result[key] = value[key]
    for key in BOOLS:
        if type(value.get(key)) is bool:
            result[key] = value[key]
    for key, maximum in COUNTS.items():
        if type(value.get(key)) is int and 0 <= value[key] <= maximum:
            result[key] = value[key]
    return result


def phone(value):
    return re.sub(r"\D", "", value) if isinstance(value, str) else ""


def install(module, xc, scope):
    """Capture only existing synchronous calls; no API reads on the test path."""
    resource = xc["remote"].texts
    original_send, original_token = resource.send, module._token
    own_send = resource.__dict__.get("send")
    had_own_send = "send" in resource.__dict__
    marker = None

    def token(*args, **kwargs):
        nonlocal marker
        result = original_token(*args, **kwargs)
        marker = result if isinstance(result, str) and 1 <= len(result) <= 128 else None
        return result

    def send(*args, **kwargs):
        result = original_send(*args, **kwargs)
        try:
            body = kwargs.get("text")
            if (len(args) != 1 or str(args[0]) != str(xc["remote_pid"])
                    or phone(kwargs.get("to")) != phone(xc["aut_phone"])
                    or not marker or not isinstance(body, str) or marker not in body
                    or len(body.encode()) > MAX_TEXT):
                scope["unavailable"] = True
            elif len(scope["requests"]) >= MAX_REQUESTS:
                scope["truncated"] = True
            else:
                created = getattr(result, "created_at", None)
                scope["requests"].append({
                    "source_id": str(result.id), "source_pid": str(xc["remote_pid"]),
                    "aut_pid": str(xc["aut_pid"]), "source_phone": xc["remote_phone"],
                    "aut_phone": xc["aut_phone"], "text": body, "marker": marker,
                    "created_at": created.isoformat() if created is not None else None,
                })
        except Exception:
            scope["unavailable"] = True
        return result

    def restore():
        module._token = original_token
        if had_own_send:
            resource.send = own_send
        else:
            resource.__dict__.pop("send", None)

    try:
        module._token = token
        resource.send = send
    except Exception:
        restore()
        raise
    return restore


def timestamp(value):
    from datetime import datetime
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (AttributeError, ValueError, TypeError):
        return None


def read_request(request, factory=None):
    """Two bounded SDK reads, after the original task outcome, before cleanup."""
    records = []
    request.pop("inbound_id", None)
    accepted = False
    try:
        for key in ("source_id", "source_pid", "aut_pid", "source_phone", "aut_phone", "text", "marker"):
            if not isinstance(request.get(key), str) or not request[key]:
                raise ValueError()
        if len(request["text"].encode()) > MAX_TEXT or len(request["marker"]) > 128:
            raise ValueError()
        from uuid import UUID
        for key in ("source_id", "source_pid", "aut_pid"):
            UUID(request[key])
        accepted = True  # ID was captured from the original successful SDK send.
        if factory is None:
            from inkbox import Inkbox
            def factory(role):
                return Inkbox(api_key=os.environ["REMOTE_INKBOX_API_KEY" if role == "source" else "OPENCLAW_INKBOX_API_KEY"],
                              base_url=os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai"), timeout=2)
        with factory("source") as client:
            row = client.texts.get(request["source_pid"], request["source_id"])
        if (str(row.id) != request["source_id"] or row.direction != "outbound"
                or phone(row.local_phone_number) != phone(request["source_phone"])
                or phone(row.remote_phone_number) != phone(request["aut_phone"])
                or row.text != request["text"]):
            raise ValueError()
        state = str(getattr(row.delivery_status, "value", row.delivery_status))
        records.append({"phase": "source", "status": "observed", "accepted": True, "scope_verified": True,
                        "delivery": state if state in ENUMS["delivery"] else "unknown",
                        "sent": row.sent_at is not None, "delivered": row.delivered_at is not None,
                        "failed": row.failed_at is not None})
        # The accepted response's server clock avoids runner/server skew. Missing
        # timestamp does not fabricate a lower bound; the page remains bounded.
        lower = timestamp(request.get("created_at"))
        with factory("aut") as client:
            rows = client.texts.list(request["aut_pid"], limit=50,
                                     **({"start_datetime": lower.isoformat()} if lower else {}))
        if not isinstance(rows, list) or len(rows) > 50:
            raise ValueError()
        matches = [r for r in rows if r.direction == "inbound"
                   and phone(r.local_phone_number) == phone(request["aut_phone"])
                   and phone(r.remote_phone_number) == phone(request["source_phone"])
                   and r.text == request["text"]]
        if len(matches) == 1 and len(rows) < 50:
            request["inbound_id"] = str(matches[0].id)
        records.append({"phase": "inbound", "status": "observed", "matches": len(matches),
                        "ambiguous": len(matches) > 1, "page_full": len(rows) == 50})
    except Exception:
        records.append({"phase": "inbound" if records else "source", "status": "unavailable",
                        **({"accepted": True} if accepted and not records else {})})
    return records


def bounded_child(command, payload, timeout=60, *, own_group=True):
    """No raw output forwarding, bounded pipes, kill/reap even on timeout."""
    if own_group and not hasattr(os, "killpg"):
        raise NotImplementedError("bounded observer process groups unavailable")
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=own_group)
    try:
        wire = json.dumps(payload).encode()
        if len(wire) > 80_000:
            raise ValueError()
        deadline, output, written = time.monotonic() + timeout, bytearray(), 0
        os.set_blocking(child.stdin.fileno(), False)
        os.set_blocking(child.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdin, selectors.EVENT_WRITE)
            selector.register(child.stdout, selectors.EVENT_READ)
            stdout_open = True
            while stdout_open:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                events = selector.select(remaining)
                if not events:
                    raise TimeoutError()
                for key, _ in events:
                    if key.fileobj is child.stdin:
                        written += os.write(child.stdin.fileno(), wire[written:written + 4096])
                        if written == len(wire):
                            selector.unregister(child.stdin)
                            child.stdin.close()
                    else:
                        data = os.read(child.stdout.fileno(), min(4096, 65_537 - len(output)))
                        if not data:
                            selector.unregister(child.stdout)
                            stdout_open = False
                            break
                        output.extend(data)
                        if len(output) > 65_536:
                            raise ValueError()
        if child.wait(timeout=max(.001, deadline - time.monotonic())) != 0:
            raise ValueError()
        rows = json.loads(output)
        if not isinstance(rows, list) or not 1 <= len(rows) <= 16:
            raise ValueError()
        safe = [safe_record(row) for row in rows]
        if any(row is None for row in safe):
            raise ValueError()
        return safe
    finally:
        if own_group:
            # The nested native reader inherits this owned group. Kill it even
            # if its immediate SDK parent has already exited or timed out.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
        child.stdin.close()


def observe(scope, command=None):
    try:
        if scope.get("unavailable") or not 1 <= len(scope.get("requests", [])) <= MAX_REQUESTS:
            raise ValueError()
        rows = bounded_child(command or [sys.executable, str(Path(__file__).resolve()), "read"], scope)
        return [{"phase": "observer", "status": "observed", "requests": len(scope["requests"]),
                 "truncated": scope.get("truncated") is True}, *rows]
    except Exception:
        return [{"phase": "observer", "status": "unavailable"}]


def read_child(scope):
    rows = []
    for ordinal, request in enumerate(scope.get("requests", [])[:MAX_REQUESTS], 1):
        rows.extend({**row, "ordinal": ordinal} for row in read_request(request))
        try:
            # Bound this post-outcome child independently; the original model
            # deadline is fixed and native state is never read.
            native = bounded_child(["node", str(Path(__file__).with_name("channel_native_observer.mjs"))], request, timeout=30, own_group=False)
            rows.extend({**row, "ordinal": ordinal} for row in native if row["phase"] == "native")
        except Exception:
            rows.append({"phase": "native", "status": "unavailable", "ordinal": ordinal,
                         "transcript": "unknown", "tool_evidence": "unavailable", "model_start": "unknown", "completion": "unknown"})
    return rows


def run_tests(args):
    import pytest
    scope = {"requests": []}

    class Observer:
        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_call(self, item):
            if item.name != CASE or item.module.__name__.split(".")[-1] != MODULE:
                yield
                return
            restore = None
            try:
                restore = install(item.module, item.funcargs["xc"], scope)
            except Exception:
                scope["unavailable"] = True
            try:
                yield
            finally:
                if restore:
                    try:
                        restore()
                    except Exception:
                        scope["unavailable"] = True

        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_makereport(self, item, call):
            outcome = yield
            report = outcome.get_result()
            if (item.name == CASE and item.module.__name__.split(".")[-1] == MODULE
                    and report.when == "call" and report.failed):
                # The original call failure is already fixed, and its wrappers
                # restored. Observe before normal fixture teardown so the
                # existing session sweep still owns effects created meanwhile.
                try:
                    for record in observe(scope):
                        print("channel_failure_diagnostic " + json.dumps(record, sort_keys=True))
                except Exception:
                    pass

    return pytest.main(args, plugins=[Observer()])


if __name__ == "__main__":
    if sys.argv[1:] == ["read"]:
        try:
            wire = sys.stdin.buffer.read(80_001)
            if len(wire) > 80_000:
                raise ValueError()
            print(json.dumps(read_child(json.loads(wire))))
        except Exception:
            print(json.dumps([{"phase": "observer", "status": "unavailable"}]))
    else:
        raise SystemExit(run_tests(sys.argv[1:]))
