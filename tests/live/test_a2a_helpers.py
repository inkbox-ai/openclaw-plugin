"""Focused checks for repeatable A2A card preflight."""

from types import SimpleNamespace

import pytest

import a2a_driver


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
