"""Focused contracts for bounded cross-channel recovery and read resilience."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import test_cross_channel as cross


def _effect(content="fresh123", *, exact_recipient=True):
    return {"content": content, "exact_recipient": exact_recipient}


def test_email_recovery_retries_only_a_zero_side_effect_turn():
    state, detail = cross._classify_email_effects(
        token="fresh123",
        inbound=[],
        outbound=[],
        wrong_channel_count=0,
    )

    assert state == "empty"
    assert detail == "driver=0 aut=0 sms=0"


def test_email_recovery_waits_for_second_owner_before_settlement():
    state, detail = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect()],
        outbound=[],
        wrong_channel_count=0,
    )

    assert state == "pending"
    assert detail == "driver=1 aut=0 sms=0"


def test_email_recovery_accepts_exact_one_current_token_for_both_owners():
    state, detail = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect()],
        outbound=[_effect()],
        wrong_channel_count=0,
    )

    assert state == "success"
    assert detail == "driver=1 aut=1 sms=0"


def test_email_recovery_rejects_wrong_channel_side_effect():
    state, detail = cross._classify_email_effects(
        token="fresh123",
        inbound=[],
        outbound=[],
        wrong_channel_count=1,
    )

    assert state == "terminal"
    assert detail == "wrong-channel SMS rows=1"


def test_email_recovery_rejects_wrong_content_and_recipient():
    wrong_content = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect("different")],
        outbound=[],
        wrong_channel_count=0,
    )
    wrong_recipient = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect()],
        outbound=[_effect(exact_recipient=False)],
        wrong_channel_count=0,
    )

    assert wrong_content == (
        "terminal",
        "driver email did not contain current token",
    )
    assert wrong_recipient == (
        "terminal",
        "aut email targeted a different recipient",
    )


def test_email_recovery_rejects_duplicates_and_late_prior_token():
    duplicate = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect(), _effect()],
        outbound=[_effect()],
        wrong_channel_count=0,
    )
    late_prior = cross._classify_email_effects(
        token="fresh123",
        inbound=[_effect("old456 fresh123")],
        outbound=[_effect("old456 fresh123")],
        wrong_channel_count=0,
        prior_tokens=("old456",),
    )

    assert duplicate == (
        "terminal",
        "duplicate email rows: driver=2 aut=1",
    )
    assert late_prior == (
        "terminal",
        "driver email also contained a prior token",
    )


def test_fresh_rows_require_new_owner_id_at_or_after_server_watermark():
    watermark = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    stale_id = SimpleNamespace(
        id="stale-id", created_at=watermark + timedelta(seconds=1)
    )
    stale_time = SimpleNamespace(
        id="new-before-watermark", created_at=watermark - timedelta(seconds=1)
    )
    fresh = SimpleNamespace(id="fresh-id", created_at=watermark)

    assert cross._fresh(
        [stale_id, stale_time, fresh], {"stale-id"}, watermark
    ) == [fresh]


def test_idempotent_read_returns_after_transient_exceptions(monkeypatch):
    attempts = []
    outcomes = iter([ConnectionError("private endpoint"), ["ok"]])
    monkeypatch.setattr(cross.time, "sleep", lambda delay: attempts.append(delay))

    def read():
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    assert cross._read_with_retry(read, "call history") == ["ok"]
    assert attempts == [cross.READ_BACKOFF_S]


def test_idempotent_read_exhaustion_is_sanitized(monkeypatch):
    monkeypatch.setattr(cross, "READ_ATTEMPTS", 2)
    monkeypatch.setattr(cross.time, "sleep", lambda _delay: None)

    def read():
        raise ConnectionError("https://private.invalid/resource?id=secret")

    with pytest.raises(AssertionError) as failure:
        cross._read_with_retry(read, "call history")

    message = str(failure.value)
    assert "ConnectionError" in message
    assert "private.invalid" not in message
