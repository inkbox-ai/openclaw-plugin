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
