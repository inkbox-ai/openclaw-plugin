# tests/live/conftest.py
"""Shared guardrails for the live suite.

The live tests drive real SMS through the shared Inkbox 10DLC pool, whose
conversation-health rules (see servers ``conversation_health.py``) block a
sender once its window fills: the same body twice with no reply
(``duplicate_body``), 10 unanswered outbound (``unanswered_limit``), or 5
carrier spam-fails in a row (``carrier_spam_backoff``). Each rule keys off
the window *"since the recipient's last inbound reply"* and empties the
moment an inbound lands in that direction.

``duplicate_body`` is already handled everywhere by per-send body
diversification (each driver send carries a unique ref), and the tests
never provoke real carrier fails, so the only window that creeps up is
``unanswered_limit`` — and only in tests where the agent answers
out-of-band (voice "call me" → the agent *calls* back, never texts), so
nothing resets the opener's window.

Rather than poke an SMS before every test (which spams the real driver
phone), this autouse guardrail only resets when needed: it reads the
opener's current window and, if there's plenty of head-room, does nothing.
Only when the window is close to the cap does it land an inbound on the
opener to empty it — a cheap read per test, an actual SMS rarely.

"Opener" = whoever sends first in the test; the rule blocks the opener on
*their* window, and a window empties only on an inbound to that party, so
the reset lands on the opener. Penetrator opens by default (all current
tests); a test that opens the other way marks itself
``@pytest.mark.first_sender("aut")``.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

REMOTE_KEY = os.environ.get("REMOTE_INKBOX_API_KEY")
AUT_KEY = os.environ.get("OPENCLAW_INKBOX_API_KEY")
BASE_URL = os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai")

# Server's unanswered-outbound cap (conversation_health.UNANSWERED_OUTBOUND_LIMIT).
UNANSWERED_LIMIT = 10
# Reset once the opener's window leaves fewer than this many free sends —
# comfortably more than any single test's opener-send count.
MIN_FREE_SLOTS = 4
STALE_CALL_AGE_S = 15 * 60
RESET_SETUP_TIMEOUT_S = 30.0
RESET_REQUEST_TIMEOUT_S = 2.0
RESET_POLL_S = 0.5
RESET_MAX_POLLS = 60

# Exact transport cases collected from the live modules. Helpers live beside
# these tests but must never acquire clients or perform live setup, even when
# the CI process has real keys. Keep model test files and their selection intact.
LIVE_CASES = {
    "test_email_reply.py": {"test_email_reachability"},
    "test_sms.py": {
        "test_sms_reachability", "test_sms_basic_reply",
        "test_sms_reports_own_identity", "test_sms_reports_sender_details",
        "test_sms_aware_of_inkbox_tools", "test_sms_retry_after_carrier_delivery_failure",
        "test_sms_retry_after_internal_spam_block",
    },
    "test_email_intelligence.py": {
        "test_basic_reply", "test_reports_own_identity", "test_reports_sender_name",
        "test_aware_of_inkbox_tools", "test_contact_crud_tool_use",
    },
    "test_cross_channel.py": {
        "test_email_request_gets_sms_response", "test_sms_request_gets_email_response",
        "test_email_request_gets_call", "test_sms_request_gets_call",
    },
    "test_external_event_github.py": {
        "test_forged_github_signature_is_rejected_before_dispatch",
        "test_valid_github_signature_reaches_openclaw_dispatcher",
    },
    "test_external_event_intelligence.py": {"test_signed_external_event_reaches_openclaw_dispatcher"},
    "test_voice.py": {
        "test_inbound_call_inkbox_tts_stt", "test_outbound_call_realtime",
        "test_outbound_call_realtime_direct_contact_lookup",
        "test_outbound_call_hosted_and_settles_sms_once",
    },
}


def _is_live_case(item) -> bool:
    path = Path(item.path).resolve()
    name = getattr(item, "originalname", None) or item.name
    return path.parent == Path(__file__).resolve().parent and name in LIVE_CASES.get(path.name, ())


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "first_sender(who): which side opens the conversation in this test "
        "('penetrator' default, or 'aut') — steers the pre-test window reset.",
    )


def _client(key: str, *, timeout: float = 30.0):
    from inkbox import Inkbox

    return Inkbox(api_key=key, base_url=BASE_URL, timeout=timeout)


_ENDED_CALL_STATUSES = {"completed", "failed", "canceled"}


def _owned_calls(client, local_phone: str):
    """Newest calls owned by this live identity, keyed by call id."""
    return {
        str(call.id): call
        for call in client.calls.list(limit=100)
        if getattr(call, "local_phone_number", None) == local_phone
    }


def _call_status(call) -> str:
    return str(getattr(call, "status", "") or "").lower()


def _hang_up_owned_call(client, call) -> str | None:
    """Send the authoritative hangup command, tolerating an ended-call race."""
    call_id = str(call.id)
    if _call_status(call) in _ENDED_CALL_STATUSES:
        return None
    try:
        client.calls.hangup(call_id)
        return None
    except Exception as exc:
        try:
            current = client.calls.get(call_id)
        except Exception as get_exc:
            return f"hangup={type(exc).__name__}; get={type(get_exc).__name__}"
        if _call_status(current) in _ENDED_CALL_STATUSES:
            return None
        return f"hangup={type(exc).__name__}; status={_call_status(current)!r}"


def _call_timestamp(call) -> float | None:
    for name in ("created_at", "started_at"):
        value = getattr(call, name, None)
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.timestamp()
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
    return None


def _finish_calls(client, local_phone: str, call_ids: set[str]) -> None:
    """Hang up and verify the exact calls owned by this pytest session."""
    deadline = time.monotonic() + 12
    last_errors: dict[str, str] = {}
    while True:
        current = _owned_calls(client, local_phone)
        live = {
            call_id: call
            for call_id, call in current.items()
            if call_id in call_ids and _call_status(call) not in _ENDED_CALL_STATUSES
        }
        if not live:
            return
        for call_id, call in live.items():
            error = _hang_up_owned_call(client, call)
            if error:
                last_errors[call_id] = error
        if time.monotonic() >= deadline:
            states = sorted(_call_status(call) for call in live.values())
            raise RuntimeError(
                "live-test calls remained active after API cleanup: "
                f"count={len(live)} states={states!r} error_count={len(last_errors)}"
            )
        time.sleep(0.5)


def _cleanup_targets(
    baseline: set[str], current: set[str], explicitly_owned: set[str]
) -> set[str]:
    return explicitly_owned | (current - baseline)


@pytest.fixture(scope="session")
def live_call_cleanup():
    """Clean stale calls, then tear down only calls explicitly owned by this run."""
    if not AUT_KEY:
        yield lambda _call_id: None
        return

    client = _client(AUT_KEY)
    numbers = client.phone_numbers.list()
    if not numbers:
        raise RuntimeError("live-test identity has no phone number for call cleanup")
    local_phone = numbers[0].number
    baseline = set(_owned_calls(client, local_phone))
    now = time.time()
    for call in _owned_calls(client, local_phone).values():
        created_at = _call_timestamp(call)
        if (
            _call_status(call) not in _ENDED_CALL_STATUSES
            and created_at is not None
            and now - created_at >= STALE_CALL_AGE_S
        ):
            _hang_up_owned_call(client, call)

    owned: set[str] = set()

    def own(call_id) -> None:
        if call_id:
            owned.add(str(call_id))

    try:
        yield own
    finally:
        # Explicitly owned calls are the primary cleanup path. The final
        # session sweep catches unexpected model-created calls, but unlike the
        # old watchdog it cannot terminate a call while its test is running.
        current = set(_owned_calls(client, local_phone))
        _finish_calls(client, local_phone, _cleanup_targets(baseline, current, owned))


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


@pytest.fixture(scope="session")
def _reset_channel():
    """Only exact live cases request these short-timeout clients.

    Phone-number reads happen inside the per-case setup budget. SDK 0.7.6
    has two connect retries: a final in-flight request can exceed the polling
    deadline by its finite transport timeout/retry overhead (not a hard wall).
    """
    from contextlib import ExitStack

    with ExitStack() as stack:
        aut = stack.enter_context(_client(AUT_KEY, timeout=RESET_REQUEST_TIMEOUT_S))
        remote = stack.enter_context(_client(REMOTE_KEY, timeout=RESET_REQUEST_TIMEOUT_S))
        yield aut, remote


def _before_reset_operation(deadline):
    if time.monotonic() >= deadline:
        raise RuntimeError("live reset receipt/readiness not confirmed within setup budget")


def _reset_endpoints(clients, deadline):
    aut, remote = clients
    try:
        _before_reset_operation(deadline)
        aut_nums = aut.phone_numbers.list()
        _before_reset_operation(deadline)
        remote_nums = remote.phone_numbers.list()
        _before_reset_operation(deadline)
        if not (aut_nums and remote_nums):
            raise RuntimeError("live reset identity has no phone number")
        return (aut, str(aut_nums[0].id), aut_nums[0].number,
                remote, str(remote_nums[0].id), remote_nums[0].number)
    except Exception:
        raise RuntimeError("live reset endpoints unavailable") from None


def _window_count(client, pid: str, counterparty_number: str, *, deadline=None, allow_first_contact=False) -> int | None:
    """The opener's unanswered-outbound count in this conversation.

    Counts the opener's outbound to the counterparty since the opener's most
    recent inbound from them — the same "since last reply" window the server
    scores. Returns None if the history can't be read or a full page cannot
    establish enough head-room; unknown never authorizes a reset send.
    """
    if deadline is not None:
        _before_reset_operation(deadline)
    try:
        history = client.texts.get_conversation(pid, counterparty_number, limit=50, offset=0)
        if not isinstance(history, list) or len(history) > 50:
            return None
        # Do not let unrelated mailbox traffic hide this window, or trust a
        # foreign/malformed row as proof that the exact conversation is empty.
        if any(_digits(getattr(m, "remote_phone_number", "")) != _digits(counterparty_number)
               or getattr(m, "direction", None) not in {"inbound", "outbound"}
               for m in history):
            return None
        msgs = list(history)
    except Exception as exc:
        from inkbox.exceptions import InkboxAPIError

        # Number ownership was verified by _reset_endpoints. The server's
        # exact 1:1 lookup has this distinct first-contact response; all other
        # missing-resource/auth/transport errors remain unknown.
        if allow_first_contact and isinstance(exc, InkboxAPIError) and exc.status_code == 404 and exc.detail == "Conversation not found":
            return 0
        return None
    # Newest first, walk back until the last inbound; count outbound before it.
    msgs.sort(key=lambda m: str(getattr(m, "created_at", "")), reverse=True)
    count = 0
    for m in msgs:
        direction = (getattr(m, "direction", "") or "").lower()
        if direction == "inbound":
            return count
        if direction == "outbound":
            count += 1
    if len(history) >= 50 and count < UNANSWERED_LIMIT - MIN_FREE_SLOTS + 1:
        return None
    return count


def _ensure_conversation_health(channel, opener, deadline):
    aut, aut_pid, aut_phone, remote, remote_pid, driver_phone = channel
    if opener == "aut":
        receiver, receiver_pid, receiver_phone = aut, aut_pid, aut_phone
        sender, sender_pid, sender_phone = remote, remote_pid, driver_phone
    elif opener == "penetrator":
        receiver, receiver_pid, receiver_phone = remote, remote_pid, driver_phone
        sender, sender_pid, sender_phone = aut, aut_pid, aut_phone
    else:
        raise RuntimeError("invalid live reset opener")

    window = _window_count(receiver, receiver_pid, sender_phone, deadline=deadline, allow_first_contact=True)
    _before_reset_operation(deadline)
    if window is None:
        raise RuntimeError("live reset conversation window unavailable")
    if UNANSWERED_LIMIT - window >= MIN_FREE_SLOTS:
        return

    body = _sync_body()
    _before_reset_operation(deadline)
    try:
        accepted = sender.texts.send(sender_pid, to=receiver_phone, text=body)
    except Exception:
        # A rejected or ambiguous POST is not permission to issue another send.
        raise RuntimeError("live reset send rejected or unconfirmed") from None
    if not getattr(accepted, "id", None):
        raise RuntimeError("live reset send acceptance unavailable")
    created = getattr(accepted, "created_at", None)
    if not isinstance(created, datetime) or created.tzinfo is None:
        raise RuntimeError("live reset send timestamp unavailable")

    for _ in range(RESET_MAX_POLLS):
        _before_reset_operation(deadline)
        try:
            rows = receiver.texts.list(receiver_pid, limit=30, start_datetime=created.isoformat())
        except Exception:
            raise RuntimeError("live reset inbound receipt unavailable") from None
        if len(rows) >= 30:
            raise RuntimeError("live reset inbound receipt page incomplete")
        exact = [row for row in rows
                 if getattr(row, "direction", None) == "inbound"
                 and getattr(row, "id", None)
                 and _digits(getattr(row, "local_phone_number", "")) == _digits(receiver_phone)
                 and _digits(getattr(row, "remote_phone_number", "")) == _digits(sender_phone)
                 and getattr(row, "text", None) == body
                 and isinstance(getattr(row, "created_at", None), datetime)
                 and row.created_at.tzinfo is not None and row.created_at >= created]
        if len(exact) > 1:
            raise RuntimeError("live reset inbound receipt ambiguous")
        if len(exact) == 1:
            window = _window_count(receiver, receiver_pid, sender_phone, deadline=deadline)
            if window is None:
                raise RuntimeError("live reset refreshed window unavailable")
            _before_reset_operation(deadline)
            if UNANSWERED_LIMIT - window >= MIN_FREE_SLOTS:
                return
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(RESET_POLL_S, remaining))
    raise RuntimeError("live reset receipt/readiness not confirmed within setup budget")


@pytest.fixture(autouse=True)
def _reset_conversation_health(request):
    """Reset the opener's conversation window only when it's running low.

    See the module docstring for the who-opens / which-window logic.
    """
    if not _is_live_case(request.node):
        yield
        return
    # Resolve both session fixtures only after the exact live-case boundary.
    # Cleanup still owns new model-created calls, even if reset setup fails.
    request.getfixturevalue("live_call_cleanup")
    if REMOTE_KEY and AUT_KEY:
        deadline = time.monotonic() + RESET_SETUP_TIMEOUT_S
        clients = request.getfixturevalue("_reset_channel")
        channel = _reset_endpoints(clients, deadline)
        marker = request.node.get_closest_marker("first_sender")
        opener = (marker.args[0] if marker and marker.args else "penetrator").lower()
        _ensure_conversation_health(channel, opener, deadline)
    yield


def _sync_body() -> str:
    # Unique + benign: never trips duplicate_body or the content filter.
    return f"[test-sync] conversation reset {uuid.uuid4().hex}"
