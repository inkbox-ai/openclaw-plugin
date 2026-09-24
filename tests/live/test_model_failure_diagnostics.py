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


def test_observed_empty_tool_guard_projects_only_fixed_reason_and_source_flags():
    from model_failure_diagnostics import EMPTY_TOOLS_PREFIX, EMPTY_TOOLS_SUFFIX
    examples = [
        ("tools.allow: inkbox", "no registered tools matched", "reason=no_match global=true runtime=false other=false global_inkbox_only=true"),
        ("tools.allow: private-tool; runtime toolsAllow: private-tool", "tools are disabled for this run", "reason=run_disabled global=true runtime=true other=false global_inkbox_only=false"),
        ("agents.private-id.tools.allow: private-tool", "the selected model does not support tools", "reason=model_unsupported global=false runtime=false other=true global_inkbox_only=false"),
    ]
    for sources, reason, expected in examples:
        error = f"{EMPTY_TOOLS_PREFIX}{sources}); {reason}{EMPTY_TOOLS_SUFFIX}"
        record = {"level": "error", "message": "Embedded agent failed before reply: " + error}
        shapes = native_model_failure_shapes(json.dumps(record))
        assert shapes[-1] == "native_empty_tools " + expected
        assert "private" not in " ".join(shapes)
        for changed in ["quoted " + error, error + " private", error.replace(reason, "private-reason")]:
            assert not any(shape.startswith("native_empty_tools") for shape in native_model_failure_shapes(json.dumps({**record, "message": "Embedded agent failed before reply: " + changed})))


def test_native_catalog_and_factory_markers_require_exact_native_envelopes():
    records = [
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode: cataloged 54 tools behind exec/wait"},
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode: cataloged 99999999 tools behind exec/wait"},
        {"subsystem": "plugins", "level": "error", "message": "plugin tool failed (inkbox): private-path private-error"},
        {"subsystem": "inkbox", "level": "error", "message": "plugin tool failed (inkbox): private"},
        {"subsystem": "plugins", "level": "error", "message": "quoted plugin tool failed (inkbox): private"},
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode: cataloged private tools behind exec/wait"},
        {"subsystem": "plugins", "level": "info", "message": "plugin tool failed (inkbox): private"},
    ]
    assert native_model_failure_shapes("\n".join(map(json.dumps, records))) == [
        "native_tool_catalog kind=code_mode count=54", "native_tool_catalog kind=code_mode count=9999",
        "native_tool_factory inkbox_failed=true",
    ]


def test_native_tool_assembly_diagnostics_project_counts_and_flags_only():
    records = [
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode diagnostic " + json.dumps({
            "boundary": "activation", "runId": "private-run", "active": True, "toolsEnabled": True,
            "rawRun": False, "toolsDisabled": False, "fallbackActive": False, "allowlist": "unset",
        })},
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode diagnostic " + json.dumps({
            "boundary": "final-surface", "runId": "private-run", "catalogToolCount": 54,
            "visibleToolNames": ["private-tool"], "fallbackActive": False,
        })},
        {"subsystem": "agents/tool-policy", "level": "debug", "message": "tool policy removed 55 tool(s) via tools.allow: private-tool",
         "rule": "tools.allow", "removedToolCount": 55, "removedTools": ["inkbox_send_email", "private-tool"], "removedToolsTruncated": True},
        {"subsystem": "plugins/tools", "level": "trace", "message": "[trace:plugin-tools] factory timings totalMs=12 factoryCount=64 shown=20 omitted=44 factories=private-owner names=[private-tool] result=single count=1 optional=false"},
    ]
    assert native_model_failure_shapes("\n".join(map(json.dumps, records))) == [
        "native_tool_activation active=true enabled=true raw=false disabled=false fallback=false runtime_allowlist=unset",
        "native_tool_surface count=54 fallback=false",
        "native_tool_policy rule=global_allow removed=55 inkbox_removed=true truncated=true",
        "native_tool_factories count=64",
    ]
    for field, value in [("subsystem", "inkbox"), ("level", "error")]:
        assert native_model_failure_shapes("\n".join(json.dumps({**record, field: value}) for record in records)) == []


def test_tool_assembly_diagnostics_fail_closed_on_unknown_types_and_bound_counts():
    def code_mode(**fields):
        return {"subsystem": "agent/embedded", "level": "info", "message": "code-mode diagnostic " + json.dumps(fields)}

    records = [
        code_mode(boundary="activation", active="private", toolsEnabled=["private"], rawRun=1,
                  toolsDisabled=None, fallbackActive={}, allowlist=["private"]),
        code_mode(boundary="final-surface", catalogToolCount=99999999, fallbackActive=True),
        code_mode(boundary="final-surface", catalogToolCount=True),
        code_mode(boundary="final-surface", catalogToolCount=-1),
        {"subsystem": "agents/tool-policy", "level": "debug", "message": "tool policy removed private",
         "rule": {"private": "tools.allow"}, "removedToolCount": "private", "removedTools": "private", "removedToolsTruncated": "true"},
        code_mode(boundary="private", catalogToolCount=54),
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode diagnostic [\"private\"]"},
        {"subsystem": "agent/embedded", "level": "info", "message": "code-mode diagnostic {private"},
        {"subsystem": "plugins/tools", "level": "trace", "message": "[trace:plugin-tools] factory timings totalMs=12 factoryCount=99999999 shown=20 omitted=44 factories=private"},
    ]
    shapes = native_model_failure_shapes("\n".join(map(json.dumps, records)))
    assert shapes == [
        "native_tool_activation active=unknown enabled=unknown raw=unknown disabled=unknown fallback=unknown runtime_allowlist=unknown",
        "native_tool_surface count=9999 fallback=true",
        "native_tool_surface count=unknown fallback=unknown",
        "native_tool_surface count=unknown fallback=unknown",
        "native_tool_policy rule=other removed=unknown inkbox_removed=unknown truncated=unknown",
        "native_tool_factories count=9999",
    ]
    assert "private" not in " ".join(shapes)


def test_truncated_tool_policy_names_cannot_prove_inkbox_was_not_removed():
    base = {"subsystem": "agents/tool-policy", "level": "debug", "message": "tool policy removed 55 tool(s) via tools.allow: private",
            "rule": "tools.allow", "removedToolCount": 55, "removedTools": ["private"]}
    for truncated, expected in [(True, "unknown"), (None, "unknown"), (False, "false")]:
        shapes = native_model_failure_shapes(json.dumps({**base, "removedToolsTruncated": truncated}))
        assert f"inkbox_removed={expected}" in shapes[0]
    shapes = native_model_failure_shapes(json.dumps({**base, "removedTools": [None], "removedToolsTruncated": False}))
    assert "inkbox_removed=unknown" in shapes[0]


def test_unknown_plugin_allowlist_warning_keeps_entry_names_private():
    record = {"subsystem": "tools", "level": "warn", "message":
              "tools.allow allowlist contains unknown entries (private-plugin). These entries won't match any tool unless the plugin is enabled."}
    assert native_model_failure_shapes(json.dumps(record)) == [
        "native_tool_allowlist_unknown global=true plugin_only=true"
    ]
    for changed in [
        {"level": "info"}, {"subsystem": "inkbox"},
        {"message": "quoted " + record["message"]},
        {"message": record["message"] + " private"}, {"message": ["private"]},
    ]:
        assert native_model_failure_shapes(json.dumps({**record, **changed})) == []


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


def test_temporary_tool_observer_accepts_only_its_complete_fixed_projection():
    line = ("native_tool_probe phase=owner assembly=2 selected=true snapshot=true scoped=false "
            "index=true enabled=true ordered=false owner=true complete=false cold=true "
            "registrations=0 returned=unknown")
    assert native_model_failure_shapes(line) == [line]
    assert native_model_failure_shapes("native_tool_probe status=installed") == ["native_tool_probe status=installed"]
    for invalid in ("private " + line, line + " private", line.replace("assembly=2", "assembly=10000"),
                    line.replace("snapshot=true", "snapshot=private"), line.replace("phase=owner", "phase=private"),
                    json.dumps({"message": line, "subsystem": "unrelated"})):
        assert native_model_failure_shapes(invalid) == []


def test_temporary_loaded_plugin_projection_is_closed_and_content_free():
    line = ("native_plugin_load assembly=2 state=error phase=register complete=false declared=54 names=0 "
            "errors=1 warnings=0 code=EACCES sdk_incompatible=false")
    assert native_model_failure_shapes(line) == [line]
    for invalid in (line + " private", "private " + line, line.replace("state=error", "state=private"),
                    line.replace("code=EACCES", "code=private-secret"), line.replace("names=0", "names=10000"),
                    json.dumps({"message": line, "subsystem": "unrelated"})):
        assert native_model_failure_shapes(invalid) == []


def test_malformed_oversized_and_bounded_tail_records(tmp_path):
    path = tmp_path / "gateway.log"
    valid = json.dumps(_native())
    oversized = json.dumps(_native(rawErrorPreview="private" * MAX_RECORD_BYTES))
    path.write_text("private" * MAX_LOG_BYTES + "\n" + oversized + "\n" + "not-json\n" + (valid + "\n") * 25)
    assert read_native_model_failure_shapes(path) == [
        "native_model_error copy_kind=provider_internal reason=server_error status=503"
    ] * 20
    assert read_native_model_failure_shapes(tmp_path / "missing-private-path") == ["native_model_diagnostics=unavailable"]
