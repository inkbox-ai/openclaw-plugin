import json

from model_failure_diagnostics import (
    KNOWN_COPIES,
    MAX_LOG_BYTES,
    MAX_RECORD_BYTES,
    native_model_failure_shapes,
    native_timeline_shapes,
    read_native_model_failure_shapes,
    read_native_timeline_shapes,
)


def _native(**changes):
    return {
        "subsystem": "agent/embedded", "level": "warn",
        "event": "embedded_run_agent_end", "isError": True,
        "failoverReason": "server_error", "httpCode": "503",
        "error": next(text for text, kind in KNOWN_COPIES.items() if kind == "provider_internal"),
        "rawErrorPreview": "private prompt and API response", "runId": "private-id",
        **changes,
    }


def test_native_structured_reason_and_status_never_include_private_fields():
    log = json.dumps(_native()) + "\n" + json.dumps({
        "subsystem": "provider-transport-fetch", "level": "info",
        "message": "[model-fetch] response provider=private-provider api=private-api model=private-model status=503 elapsedMs=12 private=https://example.test/secret",
    })
    assert native_model_failure_shapes(log) == [
        "native_model_error copy_kind=provider_internal reason=server_error status=503",
        "native_model_transport status=503",
    ]


def test_diagnostics_require_actual_native_record_discriminators_not_prompt_substrings():
    shapes = [
        _native(subsystem="inkbox"), _native(event="message_received"),
        _native(level="info"), _native(isError="true"),
        _native(level=["warn"]), _native(level={"private": "error"}),
        {"subsystem": "agent/embedded", "level": "warn", "message": json.dumps(_native())},
        {"prompt": json.dumps(_native())},
    ]
    assert native_model_failure_shapes("\n".join(map(json.dumps, shapes))) == []


def test_unknown_fields_and_copy_suffixes_remain_unknown_without_leaking():
    copy = next(text for text, kind in KNOWN_COPIES.items() if kind == "generic_external")
    log = "\n".join(map(json.dumps, [
        _native(error=copy, failoverReason="format", httpStatus=400),
        _native(error=copy + "private", failoverReason="server_error private", httpCode="503private"),
        _native(error={"private": "secret"}, failoverReason=["secret"], httpCode=True),
    ]))
    assert native_model_failure_shapes(log) == [
        "native_model_error copy_kind=generic_external reason=format status=400",
        "native_model_error copy_kind=other reason=unknown status=unknown",
        "native_model_error copy_kind=other reason=unknown status=unknown",
    ]


def test_native_root_fallback_projects_only_fixed_phase_not_error_suffix():
    message = "Embedded agent failed before reply: private provider URL and prompt"
    records = [
        {"level": "error", "message": message},
        {"level": "error", "subsystem": "inkbox", "message": message},
        {"level": "info", "message": message},
        {"level": "error", "message": "quoted " + message},
        {"level": "error", "message": {"private": message}},
    ]
    assert native_model_failure_shapes("\n".join(map(json.dumps, records))) == [
        "native_model_phase before_reply_failure=true", "native_model_cause kind=unknown"
    ]


def test_source_verified_error_templates_never_echo_suffixes_or_near_matches():
    examples = {
        "Agent session has no lifecycle-owned base stream.": "base_stream_owner_missing",
        "Embedded stream has no lifecycle runtime owner.": "stream_owner_missing",
        "Cannot prepare a retired plugin registry": "registry_retired",
        "prepared model runtime publication was superseded for /private/session.json": "model_publication_superseded",
        "prepared model runtime publication was superseded": "model_publication_superseded",
        "prepared model runtime publication was superseded without a current replacement refresh": "model_publication_superseded",
        "Agent session has no lifecycle-owned base stream. private": "unknown",
        "quoted Cannot prepare a retired plugin registry": "unknown",
    }
    for message, kind in examples.items():
        record = {"level": "error", "message": "Embedded agent failed before reply: " + message}
        assert native_model_failure_shapes(json.dumps(record)) == [
            "native_model_phase before_reply_failure=true", f"native_model_cause kind={kind}"
        ]


def test_lane_classification_requires_native_logger_and_a_closed_class_name():
    base = {"subsystem": "diagnostic", "level": "error", "message": 'lane task error: lane=private error="private prompt"'}
    records = [
        {**base, "errorName": "TypeError"}, {**base, "errorName": "private-class"},
        {**base, "errorName": ["secret"]}, {**base, "subsystem": "inkbox", "errorName": "Error"},
        {**base, "message": "quoted " + base["message"], "errorName": "Error"},
        {**base, "errorName": "PreparedModelRuntimePublicationSupersededError"},
    ]
    assert native_model_failure_shapes("\n".join(map(json.dumps, records))) == [
        "native_lane_error name=TypeError", "native_lane_error name=unknown", "native_lane_error name=unknown",
        "native_lane_error name=PreparedModelRuntimePublicationSupersededError",
    ]


def test_native_timeline_projects_only_fixed_preparation_stages(tmp_path):
    base = {"schemaVersion": "openclaw.diagnostics.v1", "name": "agent.prepare", "phase": "agent.prepare",
            "type": "span.error", "attributes": {"stage": "attempt.session-runtime", "private": "secret"},
            "errorName": "Error", "errorMessage": "Cannot prepare a retired plugin registry", "spanId": "private-id"}
    records = [
        base, {**base, "type": "span.end"}, {**base, "attributes": {"stage": "private-path"}, "errorName": "private", "errorMessage": "private"},
        {**base, "schemaVersion": "other"}, {**base, "name": "model.prompt"}, {**base, "phase": "other"},
        {**base, "type": "span.start"}, {**base, "type": ["span.error"]},
        {**base, "attributes": ["private"], "errorName": {"private": "secret"}, "errorMessage": ["secret"]},
    ]
    expected = [
        "native_prepare failed=attempt.session-runtime name=Error kind=registry_retired",
        "native_prepare completed=attempt.session-runtime",
        "native_prepare failed=unknown name=unknown kind=unknown",
        "native_prepare failed=unknown name=unknown kind=unknown",
    ]
    log = "\n".join(json.dumps(record, ensure_ascii=False) for record in records)
    assert native_timeline_shapes(log) == expected
    for stage in ("runtime", "context-engine"):
        assert native_timeline_shapes(json.dumps({**base, "attributes": {"stage": stage}})) == [
            f"native_prepare failed={stage} name=Error kind=registry_retired"
        ]
    path = tmp_path / "native-timeline.jsonl"
    path.write_text("private" * MAX_LOG_BYTES + "\n" + log)
    assert read_native_timeline_shapes(path) == expected
    assert read_native_timeline_shapes(tmp_path / "private-missing") == ["native_timeline_diagnostics=unavailable"]


def test_json_string_unicode_separators_do_not_split_native_records():
    log = json.dumps(_native(rawErrorPreview="private\u0085provider\u2028details\u2029"), ensure_ascii=False)
    assert native_model_failure_shapes(log) == [
        "native_model_error copy_kind=provider_internal reason=server_error status=503"
    ]


def test_malformed_oversized_and_bounded_tail_records(tmp_path):
    path = tmp_path / "gateway.log"
    valid = json.dumps(_native())
    oversized = json.dumps(_native(rawErrorPreview="private" * MAX_RECORD_BYTES))
    path.write_text("private" * MAX_LOG_BYTES + "\n" + oversized + "\n" + "not-json\n" + (valid + "\n") * 25)
    assert read_native_model_failure_shapes(path) == [
        "native_model_error copy_kind=provider_internal reason=server_error status=503"
    ] * 20
    assert read_native_model_failure_shapes(tmp_path / "missing-private-path") == ["native_model_diagnostics=unavailable"]
