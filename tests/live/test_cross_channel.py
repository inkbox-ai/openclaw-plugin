"""Live cross-channel suite — the agent answers on a DIFFERENT channel.

Ask on one channel; the agent must figure out the sender's *other-channel* address
from the contact card and respond there. Each request carries a short token, and we
assert that token shows up on the other channel — proving the response is tied to
the request.

  * email -> SMS : email asks for a text; we poll SMS for the token.
  * SMS  -> email: SMS asks for an email; we poll email for the token.

Voice is the odd one out: an unanswered call carries no token, so instead of
matching content we assert that a *new inbound call from the AUT's number* lands
on the driver's number within the window — proof the request reasoned its way to
``inkbox_place_call`` and Inkbox actually dialed the driver.

  * email -> call: email asks the agent to call; we poll the driver's calls.
  * SMS   -> call: SMS asks the agent to call; we poll the driver's calls.

More channels (iMessage) get added here. Real-model only.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from datetime import datetime, timezone
from email.utils import parseaddr

import pytest

REMOTE_KEY = os.environ.get("REMOTE_INKBOX_API_KEY")
AUT_KEY = os.environ.get("OPENCLAW_INKBOX_API_KEY")
BASE_URL = os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai")
REAL = os.environ.get("LIVE_REAL_MODEL") == "1"
TIMEOUT_S = float(os.environ.get("LIVE_XCHANNEL_TIMEOUT", "200"))
CALL_ATTEMPTS = 1
EMAIL_ATTEMPTS = 1
POLL_EVERY_S = 6.0
# A cross-channel assertion observes the tool side effect before OpenClaw has
# necessarily finished the agent turn that produced it.  Starting the next test
# against the same contact/session at that boundary can race the still-active
# turn and lose the new inbound webhook.  Give delivery of the source-channel
# final reply (and session teardown) a short bounded window to finish.
POST_TOOL_TURN_SETTLE_S = 5.0
EMAIL_DUPLICATE_GRACE_S = 2 * POLL_EVERY_S

pytestmark = pytest.mark.skipif(
    not (REMOTE_KEY and AUT_KEY and REAL),
    reason="cross-channel suite: needs both keys + LIVE_REAL_MODEL=1",
)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _client(key):
    from inkbox import Inkbox

    return Inkbox(api_key=key, base_url=BASE_URL)


def _token() -> str:
    return uuid.uuid4().hex[:6]


def _settle_after_tool_side_effect() -> None:
    time.sleep(POST_TOOL_TURN_SETTLE_S)


def _created_at(value) -> datetime | None:
    """Return an aware server timestamp from an SDK resource row."""
    value = getattr(value, "created_at", None)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _snapshot(rows) -> tuple[set, datetime]:
    """Capture owner IDs plus the newest server timestamp before one request."""
    rows = list(rows)
    timestamps = [created for row in rows if (created := _created_at(row))]
    return (
        {row.id for row in rows},
        max(timestamps, default=datetime.fromtimestamp(0, tz=timezone.utc)),
    )


def _fresh(rows, before_ids: set, watermark: datetime):
    """Reject stale rows by both owner ID and the pre-request server watermark."""
    return [
        row for row in rows
        if row.id not in before_ids
        and (created := _created_at(row)) is not None
        and created >= watermark
    ]


def _email_address(value: str) -> str:
    return parseaddr(value or "")[1].casefold()


def _classify_email_effects(
    *,
    token: str,
    inbound: list[dict],
    outbound: list[dict],
    wrong_channel_count: int,
    prior_tokens: tuple[str, ...] = (),
) -> tuple[str, str]:
    """Classify one run's external effects without masking partial failures.

    ``empty`` is the only retryable result. ``pending`` permits the two owners'
    email rows to settle. Every wrong-channel, wrong-content, wrong-recipient,
    duplicate, or late-previous-attempt effect is terminal.
    """
    if wrong_channel_count:
        return "terminal", f"wrong-channel SMS rows={wrong_channel_count}"
    if len(inbound) > 1 or len(outbound) > 1:
        return (
            "terminal",
            f"duplicate email rows: driver={len(inbound)} aut={len(outbound)}",
        )
    if not inbound and not outbound:
        return "empty", "driver=0 aut=0 sms=0"

    for owner, rows in (("driver", inbound), ("aut", outbound)):
        if rows and token not in rows[0]["content"]:
            return "terminal", f"{owner} email did not contain current token"
        if rows and any(old in rows[0]["content"] for old in prior_tokens):
            return "terminal", f"{owner} email also contained a prior token"
        if rows and not rows[0]["exact_recipient"]:
            return "terminal", f"{owner} email targeted a different recipient"
    if not inbound or not outbound:
        return "pending", f"driver={len(inbound)} aut={len(outbound)} sms=0"
    return "success", "driver=1 aut=1 sms=0"


@pytest.fixture(scope="module")
def xc():
    remote = _client(REMOTE_KEY)
    aut = _client(AUT_KEY)
    remote_email = remote.mailboxes.list()[0].email_address
    aut_email = aut.mailboxes.list()[0].email_address
    rnums = remote.phone_numbers.list()
    anums = aut.phone_numbers.list()
    assert rnums and anums, "both identities need a phone number for cross-channel"
    remote_phone, remote_pid = rnums[0].number, str(rnums[0].id)
    aut_phone, aut_pid = anums[0].number, str(anums[0].id)

    # The agent can only cross channels if the sender's card has BOTH an email and a
    # phone. Ensure it does (merge in whatever is missing; never clobber existing data).
    from inkbox.contacts.types import ContactEmail, ContactPhone
    matches = aut.contacts.lookup(email=remote_email)
    if not matches:
        aut.contacts.create(
            given_name="Penny", family_name="Tester",
            emails=[ContactEmail("work", remote_email)],
            phones=[ContactPhone("mobile", remote_phone)],
        )
    else:
        c = matches[0]
        emails = list(getattr(c, "emails", []))
        phones = list(getattr(c, "phones", []))
        changed = False
        if not any((e.value or "").lower() == remote_email.lower() for e in emails):
            emails.append(ContactEmail("work", remote_email))
            changed = True
        if not any(_digits(p.value)[-10:] == _digits(remote_phone)[-10:] for p in phones):
            phones.append(ContactPhone("mobile", remote_phone))
            changed = True
        if changed:
            aut.contacts.update(c.id, emails=emails, phones=phones)

    return {
        "remote": remote, "aut": aut,
        "remote_email": remote_email, "remote_pid": remote_pid,
        "remote_phone": remote_phone,
        "aut_email": aut_email, "aut_phone": aut_phone, "aut_pid": aut_pid,
    }


def test_email_request_gets_sms_response(xc):
    """Email asks the agent to TEXT a code; the code must arrive over SMS."""
    remote, remote_pid, aut_phone = xc["remote"], xc["remote_pid"], xc["aut_phone"]
    token = _token()
    tail = _digits(aut_phone)[-10:]

    def _sms_from_aut():
        return [m for m in remote.texts.list(remote_pid, limit=30)
                if (getattr(m, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(m, "remote_phone_number", "") or "")[-10:] == tail]

    before = {m.id for m in _sms_from_aut()}
    remote.messages.send(
        xc["remote_email"], to=[xc["aut_email"]], subject=f"[{token}] text me please",
        body_text=(
            "Use inkbox_send_sms to send my phone number from my contact "
            f"details an SMS that says: lalala {token}. Do not reply by email; "
            "this is complete only after the SMS is sent."
        ),
    )

    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
        for m in _sms_from_aut():
            if m.id not in before and token in (getattr(m, "text", "") or "").lower():
                _settle_after_tool_side_effect()
                return  # cross-channel confirmed: email request -> SMS response with the token
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        f"agent did not send the current marker by SMS within {TIMEOUT_S:.0f}s"
    )


def _inbound_emails_from_aut(remote, remote_email: str, aut_email: str):
    from inkbox.mail.types import MessageDirection

    return [
        message for message in remote.messages.list(
            remote_email, direction=MessageDirection.INBOUND
        )
        if _email_address(getattr(message, "from_address", ""))
        == aut_email.casefold()
    ]


def _outbound_emails(aut, aut_email: str):
    from inkbox.mail.types import MessageDirection

    return list(
        aut.messages.list(aut_email, direction=MessageDirection.OUTBOUND)
    )


def _inbound_sms_from_aut(remote, remote_pid: str, aut_phone: str):
    tail = _digits(aut_phone)[-10:]
    return [
        message for message in remote.texts.list(remote_pid, limit=30)
        if (getattr(message, "direction", "") or "").lower() == "inbound"
        and _digits(
            getattr(message, "remote_phone_number", "") or ""
        )[-10:] == tail
    ]


def _outbound_sms(aut, aut_pid: str):
    return [
        message for message in aut.texts.list(aut_pid, limit=30)
        if (getattr(message, "direction", "") or "").lower() == "outbound"
    ]


def _email_effect(client, mailbox: str, message, recipient: str) -> dict:
    detail = client.messages.get(mailbox, message.id)
    content = " ".join(
        str(value or "")
        for value in (
            getattr(message, "subject", ""),
            getattr(message, "snippet", ""),
            getattr(detail, "body_text", ""),
        )
    ).casefold()
    recipients = {
        _email_address(value)
        for value in (getattr(message, "to_addresses", None) or [])
    }
    return {
        "id": message.id,
        "content": content,
        "exact_recipient": recipients == {recipient.casefold()},
    }


def _observe_email_run(
    xc, baselines: dict, token: str, prior_tokens: tuple[str, ...] = ()
):
    driver_rows = _fresh(
        _inbound_emails_from_aut(
            xc["remote"], xc["remote_email"], xc["aut_email"]
        ),
        baselines["driver"][0],
        baselines["driver"][1],
    )
    aut_rows = _fresh(
        _outbound_emails(xc["aut"], xc["aut_email"]),
        baselines["aut"][0],
        baselines["aut"][1],
    )
    driver_sms_rows = _fresh(
        _inbound_sms_from_aut(
            xc["remote"], xc["remote_pid"], xc["aut_phone"]
        ),
        baselines["driver_sms"][0],
        baselines["driver_sms"][1],
    )
    aut_sms_rows = _fresh(
        _outbound_sms(xc["aut"], xc["aut_pid"]),
        baselines["aut_sms"][0],
        baselines["aut_sms"][1],
    )
    inbound = [
        _email_effect(
            xc["remote"], xc["remote_email"], row, xc["remote_email"]
        )
        for row in driver_rows
    ]
    outbound = [
        _email_effect(
            xc["aut"], xc["aut_email"], row, xc["remote_email"]
        )
        for row in aut_rows
    ]
    state, detail = _classify_email_effects(
        token=token,
        inbound=inbound,
        outbound=outbound,
        wrong_channel_count=len(driver_sms_rows) + len(aut_sms_rows),
        prior_tokens=prior_tokens,
    )
    return state, detail, (
        len(driver_rows),
        len(aut_rows),
        len(driver_sms_rows),
        len(aut_sms_rows),
    )


def test_sms_request_gets_email_response(xc):
    """SMS asks the agent to EMAIL a code; the code must arrive over email.

    The request is single-attempt. Both resource owners must prove one exact
    current email and no wrong-channel SMS.
    """
    remote = xc["remote"]
    initial_rows = {
        "driver": _inbound_emails_from_aut(
            remote, xc["remote_email"], xc["aut_email"]
        ),
        "aut": _outbound_emails(xc["aut"], xc["aut_email"]),
        "driver_sms": _inbound_sms_from_aut(
            remote, xc["remote_pid"], xc["aut_phone"]
        ),
        "aut_sms": _outbound_sms(xc["aut"], xc["aut_pid"]),
    }
    run_baselines = {name: _snapshot(rows) for name, rows in initial_rows.items()}
    attempt_states = []
    attempt_tokens = []
    overall_deadline = time.monotonic() + TIMEOUT_S
    observation_deadline = (
        overall_deadline
        - EMAIL_DUPLICATE_GRACE_S
        - POST_TOOL_TURN_SETTLE_S
    )
    assert observation_deadline > time.monotonic(), (
        "LIVE_XCHANNEL_TIMEOUT must exceed duplicate and turn-settlement grace"
    )

    for attempt in range(EMAIL_ATTEMPTS):
        # Re-snapshot IDs and server watermarks before each fresh token/request.
        # The original run baseline is retained separately so a late attempt-one
        # effect can never be claimed by attempt two.
        attempt_rows = {
            "driver": _inbound_emails_from_aut(
                remote, xc["remote_email"], xc["aut_email"]
            ),
            "aut": _outbound_emails(xc["aut"], xc["aut_email"]),
            "driver_sms": _inbound_sms_from_aut(
                remote, xc["remote_pid"], xc["aut_phone"]
            ),
            "aut_sms": _outbound_sms(xc["aut"], xc["aut_pid"]),
        }
        attempt_baselines = {
            name: _snapshot(rows) for name, rows in attempt_rows.items()
        }
        if attempt_tokens:
            state, detail, counts = _observe_email_run(
                xc,
                run_baselines,
                attempt_tokens[-1],
                tuple(attempt_tokens[:-1]),
            )
            if state == "success":
                time.sleep(EMAIL_DUPLICATE_GRACE_S)
                state, detail, counts = _observe_email_run(
                    xc,
                    run_baselines,
                    attempt_tokens[-1],
                    tuple(attempt_tokens[:-1]),
                )
                assert state == "success", (
                    "late email side effects invalidated the exact-one result: "
                    f"{detail}"
                )
                _settle_after_tool_side_effect()
                return
            if state != "empty":
                pytest.fail(
                    "prior email attempt produced a late/partial external effect; "
                    f"refusing to retry: {detail} counts={counts}"
                )

        token = _token()
        attempt_tokens.append(token)
        remote.texts.send(
            xc["remote_pid"],
            to=xc["aut_phone"],
            text=(
                "Use inkbox_send_email to send my email address from my contact "
                f"details an email containing the code {token}. Do not send the "
                "code back by SMS; this is complete only after the email is sent. "
                f"(attempt {attempt + 1}, ref {token})"
            ),
        )

        attempts_left = EMAIL_ATTEMPTS - attempt
        remaining = max(0.0, observation_deadline - time.monotonic())
        attempt_deadline = time.monotonic() + remaining / attempts_left
        while time.monotonic() < attempt_deadline:
            state, detail, counts = _observe_email_run(
                xc, run_baselines, token, tuple(attempt_tokens[:-1])
            )
            if state == "terminal":
                pytest.fail(
                    f"email attempt {attempt + 1} produced an "
                    f"unsafe external effect: {detail} counts={counts}"
                )
            if state == "success":
                time.sleep(EMAIL_DUPLICATE_GRACE_S)
                state, detail, counts = _observe_email_run(
                    xc, run_baselines, token, tuple(attempt_tokens[:-1])
                )
                assert state == "success", (
                    "email duplicate grace found a late/duplicate/wrong-channel "
                    f"effect: {detail} counts={counts}"
                )
                _settle_after_tool_side_effect()
                return
            time.sleep(
                min(POLL_EVERY_S, max(0.0, attempt_deadline - time.monotonic()))
            )

        state, detail, counts = _observe_email_run(
            xc, run_baselines, token, tuple(attempt_tokens[:-1])
        )
        attempt_fresh = {
            name: len(
                _fresh(
                    attempt_rows_now,
                    attempt_baselines[name][0],
                    attempt_baselines[name][1],
                )
            )
            for name, attempt_rows_now in {
                "driver": _inbound_emails_from_aut(
                    remote, xc["remote_email"], xc["aut_email"]
                ),
                "aut": _outbound_emails(xc["aut"], xc["aut_email"]),
                "driver_sms": _inbound_sms_from_aut(
                    remote, xc["remote_pid"], xc["aut_phone"]
                ),
                "aut_sms": _outbound_sms(xc["aut"], xc["aut_pid"]),
            }.items()
        }
        attempt_states.append(
            f"attempt={attempt + 1} state={state} "
            f"run_counts={counts} attempt_counts={attempt_fresh} detail={detail}"
        )
        if state != "empty" or any(attempt_fresh.values()):
            pytest.fail(
                "email request produced a partial, wrong, or late external "
                f"effect; refusing to retry: {'; '.join(attempt_states)}"
            )

    pytest.fail(
        f"agent produced no email or SMS side effect after {EMAIL_ATTEMPTS} "
        f"fresh requests within one {TIMEOUT_S:.0f}s budget: "
        f"{' ; '.join(attempt_states)}"
    )


def _inbound_calls_from_aut(remote, remote_pid: str, aut_phone: str):
    """The driver's inbound calls originating from the AUT's number."""
    tail = _digits(aut_phone)[-10:]
    return [c for c in remote.calls.list(limit=30)
            if (getattr(c, "direction", "") or "").lower() == "inbound"
            and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]


def _outbound_calls_to_driver(aut, remote_phone: str):
    """The AUT-owned outbound records targeting the exact driver."""
    tail = _digits(remote_phone)[-10:]
    return [c for c in aut.calls.list(limit=30)
            if (getattr(c, "direction", "") or "").lower() == "outbound"
            and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]


def _wait_for_new_call(
    remote,
    remote_pid: str,
    aut_phone: str,
    before: set,
    aut,
    remote_phone: str,
    before_aut: set,
    timeout_s: float,
    attempt: int,
    ref: str,
):
    """Block until an inbound call from the AUT with an id not in ``before`` appears.

    ``before`` and ``before_aut`` are the two owners' pre-request snapshots, so
    stale or mismatched call legs cannot satisfy the assertion. Returns both
    fresh-leg counts on timeout so the caller retries only a truly empty model
    turn, never a partial plugin/API result.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        fresh_driver = [
            call for call in _inbound_calls_from_aut(remote, remote_pid, aut_phone)
            if call.id not in before
        ]
        fresh_aut = [
            call for call in _outbound_calls_to_driver(aut, remote_phone)
            if call.id not in before_aut
        ]
        if len(fresh_driver) > 1 or len(fresh_aut) > 1:
            pytest.fail(
                f"call request attempt {attempt} created duplicate "
                f"legs: driver={len(fresh_driver)} aut={len(fresh_aut)}"
            )
        if fresh_driver and fresh_aut:
            raw = getattr(fresh_aut[0], "voicemail_detection", "") or ""
            value = getattr(raw, "value", raw)
            assert str(value).casefold() == "disabled", (
                "cross-channel outbound call must persist voicemail detection "
                f"disabled, got {raw!r}"
            )
            _settle_after_tool_side_effect()
            return True, len(fresh_driver), len(fresh_aut)
        time.sleep(POLL_EVERY_S)
    fresh_driver = [
        call for call in _inbound_calls_from_aut(remote, remote_pid, aut_phone)
        if call.id not in before
    ]
    fresh_aut = [
        call for call in _outbound_calls_to_driver(aut, remote_phone)
        if call.id not in before_aut
    ]
    if len(fresh_driver) > 1 or len(fresh_aut) > 1:
        pytest.fail(
            f"call request attempt {attempt} created duplicate legs: "
            f"driver={len(fresh_driver)} aut={len(fresh_aut)}"
        )
    return False, len(fresh_driver), len(fresh_aut)


def test_email_request_gets_call(xc):
    """Email asks the agent to CALL; a new inbound call must land on the driver."""
    remote, aut = xc["remote"], xc["aut"]
    remote_pid, remote_phone, aut_phone = (
        xc["remote_pid"], xc["remote_phone"], xc["aut_phone"]
    )
    attempt_states = []
    for attempt in range(CALL_ATTEMPTS):
        # Re-snapshot before every request. Attempt two can therefore prove its
        # own side effect instead of accidentally claiming a late attempt-one call.
        before = {c.id for c in _inbound_calls_from_aut(remote, remote_pid, aut_phone)}
        before_aut = {c.id for c in _outbound_calls_to_driver(aut, remote_phone)}
        ref = _token()
        remote.messages.send(
            xc["remote_email"],
            to=[xc["aut_email"]],
            subject=f"please call me [{ref}]",
            body_text=(
                "Use inkbox_place_call to call my phone number from my contact "
                "details now. Do not reply by email; this is complete only after "
                f"the call is placed. (attempt {attempt + 1}, ref {ref})"
            ),
        )
        matched, driver_count, aut_count = _wait_for_new_call(
            remote,
            remote_pid,
            aut_phone,
            before,
            aut,
            remote_phone,
            before_aut,
            TIMEOUT_S / CALL_ATTEMPTS,
            attempt + 1,
            ref,
        )
        attempt_states.append(
            f"attempt={attempt + 1} driver={driver_count} aut={aut_count}"
        )
        if matched:
            return
        if driver_count or aut_count:
            pytest.fail(
                "call request produced an incomplete two-owner result; refusing "
                f"to retry: {'; '.join(attempt_states)}"
            )
    pytest.fail(
        f"agent did not place a call to the driver after {CALL_ATTEMPTS} "
        f"fresh requests within {TIMEOUT_S:.0f}s: {'; '.join(attempt_states)}"
    )


def test_sms_request_gets_call(xc):
    """SMS asks the agent to CALL; a new inbound call must land on the driver."""
    remote, aut = xc["remote"], xc["aut"]
    remote_pid, remote_phone, aut_phone = (
        xc["remote_pid"], xc["remote_phone"], xc["aut_phone"]
    )
    # Fresh body each send: the agent replies by calling, not texting, so this
    # SMS never gets an SMS reply to reset the conversation cadence. A unique
    # token avoids the duplicate_body guard and permits one bounded recovery
    # request when the real model returns an empty/incomplete turn with no tool.
    attempt_states = []
    for attempt in range(CALL_ATTEMPTS):
        before = {c.id for c in _inbound_calls_from_aut(remote, remote_pid, aut_phone)}
        before_aut = {c.id for c in _outbound_calls_to_driver(aut, remote_phone)}
        ref = _token()
        remote.texts.send(
            remote_pid,
            to=aut_phone,
            text=(
                "Use inkbox_place_call to call my phone number from my contact "
                "details now. Do not reply by SMS; this is complete only after "
                f"the call is placed. (attempt {attempt + 1}, ref {ref})"
            ),
        )
        matched, driver_count, aut_count = _wait_for_new_call(
            remote,
            remote_pid,
            aut_phone,
            before,
            aut,
            remote_phone,
            before_aut,
            TIMEOUT_S / CALL_ATTEMPTS,
            attempt + 1,
            ref,
        )
        attempt_states.append(
            f"attempt={attempt + 1} driver={driver_count} aut={aut_count}"
        )
        if matched:
            return
        if driver_count or aut_count:
            pytest.fail(
                "call request produced an incomplete two-owner result; refusing "
                f"to retry: {'; '.join(attempt_states)}"
            )
    pytest.fail(
        f"agent did not place a call to the driver after {CALL_ATTEMPTS} "
        f"fresh requests within {TIMEOUT_S:.0f}s: {'; '.join(attempt_states)}"
    )
