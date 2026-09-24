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
ERROR_NAMES = frozenset({
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError",
    "AggregateError", "AbortError", "FailoverError", "MissingAgentHarnessError",
    "AgentHarnessSessionSupersededError", "CommandLaneTaskTimeoutError",
    "PreparedModelRuntimePublicationSupersededError",
})
PREPARATION_STAGES = frozenset({
    "runtime", "context-engine",
    "attempt.setup", "attempt.skills", "attempt.tool-base", "attempt.bootstrap",
    "attempt.bundle-tools", "attempt.tool-catalog", "attempt.system-prompt",
    "attempt.transcript-lifecycle", "attempt.session-runtime",
})
EMPTY_TOOLS_PREFIX = "No callable tools remain after resolving explicit tool allowlist ("
EMPTY_TOOLS_SUFFIX = ". Fix the allowlist or enable the plugin that registers the requested tool."
TOOL_PROBE = re.compile(
    r"native_tool_probe (?:status=(?:installed|unsupported|unavailable)|"
    r"phase=(?:owner|loaded|result) assembly=(?:[0-9]{1,4}|unknown) "
    + " ".join(rf"{key}=(?:true|false|unknown)" for key in (
        "selected", "snapshot", "scoped", "index", "enabled", "ordered", "owner", "complete", "cold"
    ))
    + r" registrations=(?:[0-9]{1,4}|unknown) returned=(?:[0-9]{1,4}|unknown))"
)
PLUGIN_LOAD = re.compile(
    r"native_plugin_load assembly=(?:[0-9]{1,4}|unknown) state=(?:loaded|disabled|error|absent|unknown) "
    r"phase=(?:validation|load|register|unknown) complete=(?:true|false|unknown) "
    r"declared=(?:[0-9]{1,4}|unknown) names=(?:[0-9]{1,4}|unknown) "
    r"errors=(?:[0-9]{1,4}|unknown) warnings=(?:[0-9]{1,4}|unknown) "
    r"code=(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|ENOENT|ENOSPC|EACCES|EPERM|OC_DOCTOR_DUPLICATE_CHECK|unknown) "
    r"sdk_incompatible=(?:true|false)"
)


def _count(value: object) -> str:
    return str(min(value, 9999)) if type(value) is int and value >= 0 else "unknown"


def _flag(value: object) -> str:
    return str(value).lower() if type(value) is bool else "unknown"


def _code_mode_shape(message: object) -> str | None:
    prefix = "code-mode diagnostic "
    if not isinstance(message, str) or not message.startswith(prefix):
        return None
    try:
        fields = json.loads(message[len(prefix):])
    except (ValueError, RecursionError):
        return None
    if not isinstance(fields, dict):
        return None
    if fields.get("boundary") == "activation":
        allowlist = fields.get("allowlist")
        allowlist = allowlist if isinstance(allowlist, str) and allowlist in ("unset", "empty", "nonempty") else "unknown"
        return (f"native_tool_activation active={_flag(fields.get('active'))} "
                f"enabled={_flag(fields.get('toolsEnabled'))} raw={_flag(fields.get('rawRun'))} "
                f"disabled={_flag(fields.get('toolsDisabled'))} fallback={_flag(fields.get('fallbackActive'))} "
                f"runtime_allowlist={allowlist}")
    if fields.get("boundary") == "final-surface":
        return (f"native_tool_surface count={_count(fields.get('catalogToolCount'))} "
                f"fallback={_flag(fields.get('fallbackActive'))}")
    return None


def _empty_tools_shape(value: str) -> str | None:
    """Classify the observed native guard without exposing requested tool names."""
    if not value.startswith(EMPTY_TOOLS_PREFIX) or not value.endswith(EMPTY_TOOLS_SUFFIX):
        return None
    sources, separator, reason = value[len(EMPTY_TOOLS_PREFIX):-len(EMPTY_TOOLS_SUFFIX)].rpartition("); ")
    reasons = {
        "tools are disabled for this run": "run_disabled",
        "no registered tools matched": "no_match",
        "the selected model does not support tools": "model_unsupported",
    }
    if not separator or reason not in reasons:
        return None
    # Source labels are native constants; values and agent identifiers stay private.
    entries = sources.split("; ")
    global_present = any(entry.startswith("tools.allow: ") for entry in entries)
    runtime_present = any(entry.startswith("runtime toolsAllow: ") for entry in entries)
    other_present = any(not entry.startswith(("tools.allow: ", "runtime toolsAllow: ")) for entry in entries)
    inkbox_only = "tools.allow: inkbox" in entries
    return (f"native_empty_tools reason={reasons[reason]} global={str(global_present).lower()} "
            f"runtime={str(runtime_present).lower()} other={str(other_present).lower()} "
            f"global_inkbox_only={str(inkbox_only).lower()}")


def _error_name(value: object) -> str:
    return value if isinstance(value, str) and value in ERROR_NAMES else "unknown"


def _native_error_kind(value: object) -> str:
    # Verified native source templates only; never expose the publication path.
    if not isinstance(value, str):
        return "unknown"
    exact = {
        "Agent session has no lifecycle-owned base stream.": "base_stream_owner_missing",
        "Embedded stream has no lifecycle runtime owner.": "stream_owner_missing",
        "Cannot prepare a retired plugin registry": "registry_retired",
        "prepared model runtime publication was superseded": "model_publication_superseded",
        "prepared model runtime publication was superseded without a current replacement refresh": "model_publication_superseded",
    }
    if value in exact:
        return exact[value]
    if value.startswith("prepared model runtime publication was superseded for "):
        return "model_publication_superseded"
    return "unknown"


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
        if TOOL_PROBE.fullmatch(line) or PLUGIN_LOAD.fullmatch(line):
            shapes.append(line)
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
                error_text = message.removeprefix("Embedded agent failed before reply: ")
                kind = _native_error_kind(error_text)
                shapes.append(f"native_model_cause kind={kind}")
                tool_shape = _empty_tools_shape(error_text)
                if tool_shape:
                    shapes.append(tool_shape)
        elif record.get("subsystem") == "diagnostic" and record.get("level") == "error":
            message = record.get("message")
            if isinstance(message, str) and message.startswith("lane task error: lane="):
                shapes.append(f"native_lane_error name={_error_name(record.get('errorName'))}")
        elif record.get("subsystem") == "agent/embedded" and record.get("level") == "info":
            message = record.get("message")
            match = re.fullmatch(r"code-mode: cataloged ([0-9]{1,8}) tools behind exec/wait", message) if isinstance(message, str) else None
            if match:
                shapes.append(f"native_tool_catalog kind=code_mode count={min(int(match[1]), 9999)}")
            code_mode = _code_mode_shape(message)
            if code_mode:
                shapes.append(code_mode)
        elif record.get("subsystem") == "agents/tool-policy" and record.get("level") == "debug":
            message = record.get("message")
            if isinstance(message, str) and message.startswith("tool policy removed "):
                rule = {"tools.allow": "global_allow", "tools.deny": "global_deny"}.get(
                    record.get("rule") if isinstance(record.get("rule"), str) else "", "other"
                )
                removed = record.get("removedTools")
                inkbox = None
                if isinstance(removed, list):
                    if any(isinstance(name, str) and name.startswith("inkbox_") for name in removed):
                        inkbox = True
                    elif record.get("removedToolsTruncated") is False and all(isinstance(name, str) for name in removed):
                        inkbox = False
                shapes.append(f"native_tool_policy rule={rule} removed={_count(record.get('removedToolCount'))} "
                              f"inkbox_removed={_flag(inkbox)} truncated={_flag(record.get('removedToolsTruncated'))}")
        elif record.get("subsystem") == "plugins/tools" and record.get("level") in ("trace", "warn"):
            message = record.get("message")
            match = re.match(r"^\[trace:plugin-tools\] factory timings totalMs=[0-9]+ factoryCount=([0-9]{1,8}) shown=[0-9]+ omitted=[0-9]+ factories=", message) if isinstance(message, str) else None
            if match:
                shapes.append(f"native_tool_factories count={min(int(match[1]), 9999)}")
        elif record.get("subsystem") == "tools" and record.get("level") == "warn":
            message = record.get("message")
            if (isinstance(message, str)
                    and message.startswith("tools.allow allowlist contains unknown entries (")
                    and message.endswith("). These entries won't match any tool unless the plugin is enabled.")):
                shapes.append("native_tool_allowlist_unknown global=true plugin_only=true")
        elif record.get("subsystem") == "plugins" and record.get("level") == "error":
            message = record.get("message")
            if isinstance(message, str) and message.startswith("plugin tool failed (inkbox): "):
                shapes.append("native_tool_factory inkbox_failed=true")
    return shapes[-MAX_SHAPES:]


def native_timeline_shapes(log: str) -> list[str]:
    """Only fixed preparation stages from the host's supported native timeline."""
    shapes: list[str] = []
    for line in log.split("\n"):
        if len(line.encode("utf-8")) > MAX_RECORD_BYTES:
            continue
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(record, dict) or record.get("schemaVersion") != "openclaw.diagnostics.v1":
            continue
        if record.get("name") != "agent.prepare" or record.get("phase") != "agent.prepare":
            continue
        attributes = record.get("attributes")
        stage = attributes.get("stage") if isinstance(attributes, dict) else None
        stage = stage if isinstance(stage, str) and stage in PREPARATION_STAGES else "unknown"
        if record.get("type") == "span.end":
            shapes.append(f"native_prepare completed={stage}")
        elif record.get("type") == "span.error":
            name = _error_name(record.get("errorName"))
            kind = _native_error_kind(record.get("errorMessage"))
            shapes.append(f"native_prepare failed={stage} name={name} kind={kind}")
    return shapes[-MAX_SHAPES:]


def _read_shapes(path: Path, project, unavailable: str) -> list[str]:
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
        return project(data.decode("utf-8", errors="replace"))
    except OSError:
        return [unavailable]


def read_native_model_failure_shapes(path: Path) -> list[str]:
    return _read_shapes(path, native_model_failure_shapes, "native_model_diagnostics=unavailable")


def read_native_timeline_shapes(path: Path) -> list[str]:
    return _read_shapes(path, native_timeline_shapes, "native_timeline_diagnostics=unavailable")
