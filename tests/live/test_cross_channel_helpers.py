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


@pytest.mark.parametrize("rendered", [
    "[inkbox] source reply shape: mode=sms kind=final chars=102 error=false status=false silent=false",
    '{"message":"Inkbox source reply shape: mode=sms kind=final chars=102 error=false status=false silent=false"}',
])
def test_source_reply_diagnostics_accept_host_prefix_stripping_without_content(rendered):
    assert cross._source_reply_shapes("private-id " + rendered + " private-body") == [
        "source reply shape: mode=sms kind=final chars=102 error=false status=false silent=false"
    ]


def test_send_boundary_diagnostics_extract_only_allowlisted_metadata():
    log = "\n".join([
        "[inkbox] send tool shape: tool=inkbox_send_email chars=13 private recipient",
        "[plugins] Inkbox routed send shape: channel=inkbox chars=102 private body",
        "send tool shape: tool=untrusted-tool-name chars=5",
        '[inkbox] silent send shape: bound=true batch=true attempts=1 accepted=1 invalid=false private body',
        '{"message":"Inkbox silent send shape: bound=false batch=false attempts=0 accepted=0 invalid=false","secret":"private"}',
    ])
    assert cross._source_reply_shapes(log) == [
        "send tool shape: tool=inkbox_send_email chars=13",
        "routed send shape: channel=inkbox chars=102",
        "silent send shape: bound=true batch=true attempts=1 accepted=1 invalid=false",
        "silent send shape: bound=false batch=false attempts=0 accepted=0 invalid=false",
    ]


@pytest.mark.parametrize("late_effect,phase", [
    (None, None),
    ("duplicate email rows", 2),
    ("wrong-channel SMS rows", 2),
    ("email targeted a different recipient", 2),
    ("email did not contain current token", 2),
    ("duplicate email rows", 3),
    ("wrong-channel SMS rows", 3),
])
def test_email_poll_boundary_preserves_exact_once_settlement(
    monkeypatch, late_effect, phase
):
    """Delivery first visible at the cutoff still needs both settlement checks."""
    clock = [0.0]
    sends = []
    observations = []
    sleeps = []
    monkeypatch.setattr(cross.time, "monotonic", lambda: clock[0])

    def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    monkeypatch.setattr(cross.time, "sleep", sleep)
    monkeypatch.setattr(cross, "TIMEOUT_S", 200.0)
    monkeypatch.setattr(cross, "EMAIL_ATTEMPTS", 1)
    monkeypatch.setattr(cross, "_token", lambda: "fresh123")
    for reader in (
        "_inbound_emails_from_aut", "_outbound_emails",
        "_inbound_sms_from_aut", "_outbound_sms",
    ):
        monkeypatch.setattr(cross, reader, lambda *args: [])

    def observe(xc, baselines, token, prior_tokens):
        index = len(observations)
        observations.append(index)
        assert token == "fresh123"
        assert prior_tokens == ()
        if index == 0:
            # A pending read completes exactly at the observation cutoff.
            clock[0] = 168.0
            return "pending", "driver=0 aut=1 sms=0", (0, 1, 0, 0)
        if index == phase:
            return "terminal", late_effect, (2, 1, 0, 0)
        return "success", "driver=1 aut=1 sms=0", (1, 1, 0, 0)

    monkeypatch.setattr(cross, "_observe_email_run", observe)
    xc = {
        "remote": SimpleNamespace(texts=SimpleNamespace(
            send=lambda *args, **kwargs: sends.append((args, kwargs))
        )),
        "aut": object(),
        "remote_email": "driver@example.com",
        "aut_email": "agent@example.com",
        "remote_pid": "driver-phone",
        "aut_pid": "agent-phone",
        "remote_phone": "+12025550101",
        "aut_phone": "+12025550102",
    }

    if late_effect:
        with pytest.raises(AssertionError, match=late_effect):
            cross.test_sms_request_gets_email_response(xc)
        assert len(observations) == phase + 1
    else:
        cross.test_sms_request_gets_email_response(xc)
        assert observations == [0, 1, 2, 3]
        assert sleeps[-2:] == [
            cross.EMAIL_DUPLICATE_GRACE_S, cross.POST_TOOL_TURN_SETTLE_S,
        ]
        assert clock[0] == cross.TIMEOUT_S
    assert len(sends) == 1


@pytest.mark.parametrize("direction", ["inbound", "outbound"])
def test_email_poll_filters_history_without_capping_current_rows(direction):
    """Use the inclusive server watermark and exhaust all current pages."""
    from inkbox.mail.types import MessageDirection

    watermark = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    requests = []
    # More than one page, with equal timestamps, must all remain observable:
    # a duplicate cannot disappear behind a per-poll row cap.
    rows = [
        SimpleNamespace(
            id=str(index), created_at=watermark, from_address="agent@example.com"
        )
        for index in range(101)
    ]

    def list_messages(mailbox, **kwargs):
        requests.append((mailbox, kwargs))
        yield from rows

    client = SimpleNamespace(messages=SimpleNamespace(list=list_messages))
    if direction == "inbound":
        result = cross._inbound_emails_from_aut(
            client, "driver@example.com", "agent@example.com", since=watermark
        )
        mailbox = "driver@example.com"
        expected_direction = MessageDirection.INBOUND
    else:
        result = cross._outbound_emails(
            client, "agent@example.com", since=watermark
        )
        mailbox = "agent@example.com"
        expected_direction = MessageDirection.OUTBOUND

    assert result == rows
    assert requests == [(mailbox, {
        "direction": expected_direction,
        "start_datetime": watermark.isoformat(),
    })]
