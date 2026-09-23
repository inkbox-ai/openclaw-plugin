"""Bounded, content-free projections of native JSON gateway diagnostics."""

from __future__ import annotations

import json
import re
from pathlib import Path

MAX_LOG_BYTES = 2 * 1024 * 1024
MAX_RECORD_BYTES = 32 * 1024
MAX_SHAPES = 20
REASONS = frozenset({
    "auth", "auth_permanent", "format", "rate_limit", "overloaded", "billing",
    "server_error", "timeout", "tls_certificate", "context_overflow",
    "model_not_found", "session_expired", "empty_response", "no_error_details",
    "unclassified", "unknown",
})
KNOWN_COPIES = {
    "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.": "generic_external",
    "⚠️ openai/gpt-5.6-sol request failed (provider internal error). This is usually temporary — try again shortly.": "provider_internal",
    "LLM request failed: provider returned an internal error.": "provider_internal",
}
TRANSPORT_RESPONSE = re.compile(
    r"^\[model-fetch\] response provider=\S+ api=\S+ model=\S+ "
    r"status=([1-5][0-9]{2})(?=\s|$)"
)


def _status(value: object) -> str:
    if isinstance(value, bool):
        return "unknown"
    text = str(value) if isinstance(value, (str, int)) else ""
    return text if re.fullmatch(r"[1-5][0-9]{2}", text) else "unknown"


def native_model_failure_shapes(log: str) -> list[str]:
    """Never project free-form messages, model names, identifiers or raw errors."""
    shapes: list[str] = []
    for line in log.split("\n"):
        if len(line.encode("utf-8")) > MAX_RECORD_BYTES:
            continue
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(record, dict):
            continue
        if (
            record.get("subsystem") == "agent/embedded"
            and record.get("event") == "embedded_run_agent_end"
            and record.get("isError") is True
            and record.get("level") in ("warn", "error")
        ):
            reason = record.get("failoverReason")
            reason = reason if isinstance(reason, str) and reason in REASONS else "unknown"
            error = record.get("error")
            copy_kind = KNOWN_COPIES.get(error, "other") if isinstance(error, str) else "other"
            status = _status(record.get("httpStatus", record.get("httpCode")))
            shapes.append(f"native_model_error copy_kind={copy_kind} reason={reason} status={status}")
        elif record.get("subsystem") == "provider-transport-fetch" and record.get("level") == "info":
            message = record.get("message")
            match = TRANSPORT_RESPONSE.match(message) if isinstance(message, str) else None
            if match:
                shapes.append(f"native_model_transport status={match[1]}")
        elif "subsystem" not in record and record.get("level") == "error":
            # This native runner fallback uses defaultRuntime.error/root console.
            message = record.get("message")
            if isinstance(message, str) and message.startswith("Embedded agent failed before reply: "):
                shapes.append("native_model_phase before_reply_failure=true")
    return shapes[-MAX_SHAPES:]


def read_native_model_failure_shapes(path: Path) -> list[str]:
    """Read only a bounded tail of the existing per-run gateway log."""
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, 2)
            offset = max(0, size - MAX_LOG_BYTES)
            stream.seek(offset)
            data = stream.read(MAX_LOG_BYTES)
        if offset:
            # Never interpret a record whose prefix fell outside the read bound.
            data = data.partition(b"\n")[2]
        return native_model_failure_shapes(data.decode("utf-8", errors="replace"))
    except OSError:
        return ["native_model_diagnostics=unavailable"]
