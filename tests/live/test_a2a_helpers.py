"""Focused checks for repeatable A2A card preflight."""

from types import SimpleNamespace

import pytest

import a2a_driver


def test_failure_shapes_handle_host_prefixes_without_leaking_error_content():
    shape = "A2A failure shape: stage=dispatch name=TypeError frame=session.ts:123"
    log = (
        f"[inkbox] {shape}\n"
        f'{{"1":"Inkbox {shape}","private":"private request"}}\n'
        "A2A turn failed: private task and secret error\n"
        "A2A failure shape: stage=dispatch name=PrivateError frame=secret.ts:1\n"
        "A2A failure shape: stage=dispatch name=Error frame=/private/secret.ts:1\n"
        "A2A failure shape: stage=dispatch name=Error frame=secret.ts:1private\n"
    )
    assert a2a_driver._a2a_failure_shapes(log) == [shape, shape]
    host_shape = "A2A failure shape: stage=terminal name=Error frame=dispatch-from-config.finalize-abc.js:42"
    assert a2a_driver._a2a_failure_shapes(host_shape) == [host_shape]
    unknown = "A2A failure shape: stage=admission name=other frame=unknown:0"
    assert a2a_driver._a2a_failure_shapes(unknown) == [unknown]


def test_failure_shapes_handle_host_console_color_without_exposing_adjacent_prose():
    shape = "A2A failure shape: stage=dispatch name=Error frame=builtin-openclaw-example.mjs:42"
    assert a2a_driver._a2a_failure_shapes(
        f"private prefix \x1b[33mInkbox {shape}\x1b[39m\nprivate suffix"
    ) == [shape]
    # Removing terminal styling must not bypass the strict field boundary.
    assert a2a_driver._a2a_failure_shapes(f"{shape}\x1b[39mprivate") == []


def test_host_failure_counts_emit_only_fixed_keys_and_counts():
    log = (
        "\x1b[31mEmbedded agent failed before reply: private request\x1b[39m\n"
        "FailoverError: rate_limit_exceeded private provider details\n"
        "fetch failed: private endpoint\n"
        "HealthCheckRegistrationError private plugin details\n"
    )
    counts = a2a_driver._a2a_host_failure_counts(log)
    assert counts == {
        "host_before_reply_failure": 1,
        "host_failover_error": 1,
        "host_rate_limit_signature": 1,
        "host_auth_signature": 0,
        "host_transport_signature": 1,
        "host_session_lock_signature": 0,
        "host_tool_schema_signature": 0,
        "host_plugin_registration_signature": 1,
    }
    assert "private" not in repr(counts)


def test_host_error_sites_return_only_public_locations_not_dynamic_error_text(tmp_path):
    (tmp_path / "runtime-example.mjs").write_text(
        'throw new Error(`Unknown model transport for ${privateValue}`);\n'
        'throw new Error(`Unknown model ${privateValue}`);\n'
    )
    (tmp_path / "ignored.txt").write_text('throw new Error("private full error contents");')
    shapes = a2a_driver._a2a_host_error_sites(
        "\x1b[31mEmbedded agent failed before reply: Unknown model transport for private-secret\x1b[39m\n"
        "Embedded agent failed before reply: private unrecognized error\n",
        tmp_path,
    )
    assert shapes == [
        {"matched": True, "candidate_sites": ["runtime-example.mjs:1"], "site_count": 1},
        {"matched": False, "candidate_sites": [], "site_count": 0},
    ]
    assert "private" not in repr(shapes)
    assert str(tmp_path) not in repr(shapes)


class _Identity:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.enable_calls = 0

    def a2a_enable(self):
        self.enable_calls += 1
        return SimpleNamespace(enabled=self.enabled)


class _A2A:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.fetch_calls = 0

    def fetch_card(self, _url):
        self.fetch_calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _target(name: str):
    return SimpleNamespace(card=SimpleNamespace(name=name))


def test_card_preflight_enables_once_and_retries_only_card_reads(monkeypatch):
    monkeypatch.setattr(a2a_driver.time, "sleep", lambda _delay: None)
    identity = _Identity()
    a2a = _A2A([RuntimeError("not ready"), _target("@test-agent")])

    target = a2a_driver._enable_and_verify_card(
        identity,
        a2a,
        "https://example.test/a2a/test-agent/card",
        "test-agent",
        attempts=2,
        delay=0,
    )

    assert target.card.name == "@test-agent"
    assert identity.enable_calls == 1
    assert a2a.fetch_calls == 2


def test_card_preflight_rejects_mismatched_identity_without_retry():
    identity = _Identity()
    a2a = _A2A([_target("@different-agent")])

    with pytest.raises(AssertionError, match="did not match"):
        a2a_driver._enable_and_verify_card(
            identity,
            a2a,
            "https://example.test/a2a/test-agent/card",
            "test-agent",
        )

    assert identity.enable_calls == 1
    assert a2a.fetch_calls == 1


def test_card_preflight_requires_enablement_postcondition():
    identity = _Identity(enabled=False)
    a2a = _A2A([_target("@test-agent")])

    with pytest.raises(AssertionError, match="did not persist"):
        a2a_driver._enable_and_verify_card(
            identity,
            a2a,
            "https://example.test/a2a/test-agent/card",
            "test-agent",
        )

    assert a2a.fetch_calls == 0


def test_protocol_timeout_reports_shape_without_message_content(monkeypatch):
    clock = iter([0, 0, 2])
    monkeypatch.setattr(a2a_driver.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(a2a_driver.time, "sleep", lambda _delay: None)
    task = SimpleNamespace(
        state="TASK_STATE_WORKING",
        raw={"history": [
            {"role": "ROLE_USER", "parts": [{"text": "private request"}]},
            {"role": "ROLE_AGENT", "parts": [{"text": "private response"}]},
        ]},
    )
    a2a = SimpleNamespace(get_task=lambda *_args, **_kwargs: task)
    with pytest.raises(TimeoutError) as error:
        a2a_driver._wait_protocol_task(
            a2a, None, "private-task-id", expected={"TASK_STATE_COMPLETED"}, timeout=1
        )
    assert "last_state=TASK_STATE_WORKING history_messages=2 worker_messages=1" in str(error.value)
    assert "private" not in str(error.value)


@pytest.mark.parametrize("history, passes", [
    ([('user', 'a2a-ci-inbound-single-proof'), ('agent', 'Done')], False),
    ([('agent', 'a2a-ci-inbound-single-proof'), ('agent', 'Done')], False),
    ([('user', 'a2a-ci-inbound-single-proof')], False),
    ([('user', 'Request'), ('ROLE_AGENT', 'a2a-ci-inbound-single-proof')], True),
])
def test_inbound_completion_proof_comes_from_final_agent_reply(monkeypatch, history, passes):
    task = SimpleNamespace(id="task", state="TASK_STATE_COMPLETED", raw={"history": [
        {"role": role, "parts": [{"text": text}]} for role, text in history
    ]})
    monkeypatch.setattr(a2a_driver, "_send_task", lambda *_args: task)
    monkeypatch.setattr(a2a_driver, "_cancel_if_open", lambda *_args: None)
    a2a = SimpleNamespace(get_task=lambda *_args, **_kwargs: task)
    if passes:
        a2a_driver._inbound_single(a2a, None, 1, "proof")
    else:
        with pytest.raises(AssertionError):
            a2a_driver._inbound_single(a2a, None, 1, "proof")
