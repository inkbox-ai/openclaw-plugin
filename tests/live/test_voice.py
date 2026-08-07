"""Live voice-call suite — real phone calls, real model, transcript-verified.

Four scenarios, each run against a gateway booted in the matching speech mode (the
workflow sets that up and selects the scenario via VOICE_SCENARIO):

  * inbound_inkbox   — the driver calls the agent; the agent answers with Inkbox
                       STT/TTS and holds a turn.
  * outbound_realtime — the driver texts "call me"; the agent places a call back,
                       powered by the realtime API, and holds a turn.
  * outbound_realtime_contact — the realtime agent performs a direct read of a
                       seeded contact and answers the caller during the call.
  * outbound_hosted — the driver asks for a call; Inkbox Voice AI handles it,
                      records an SMS commitment, and OpenClaw settles that
                      commitment exactly once after hangup.

A companion driver process (voice_driver.py) bridges the driver's side of the call
over an Inkbox tunnel and speaks one line. We then read the stored call transcript
and assert both parties spoke — proving the agent reached the caller out loud.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest


# The agent answers a call request by dialing back, not by texting, so these
# driver→AUT SMS never get an SMS reply to reset the server's conversation
# cadence. Two identical no-reply sends to the same number trip the
# duplicate_body rule (422), so every call request must carry a fresh body.
_CALL_ME_PHRASINGS = (
    "Please call me right now by phone.",
    "Can you ring me now?",
    "Give me a call now.",
    "Please phone me right away.",
)


def _call_me_text() -> str:
    """A fresh call-request body each send (rotating phrasing + unique ref)."""
    phrasing = _CALL_ME_PHRASINGS[uuid.uuid4().int % len(_CALL_ME_PHRASINGS)]
    return f"{phrasing} (ref {uuid.uuid4().hex[:6]})"

REMOTE_KEY = os.environ.get("REMOTE_INKBOX_API_KEY")
AUT_KEY = os.environ.get("OPENCLAW_INKBOX_API_KEY")
BASE_URL = os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai")
REAL = os.environ.get("LIVE_REAL_MODEL") == "1"
SCENARIO = os.environ.get("VOICE_SCENARIO", "")
STATE_FILE = os.environ.get("VOICE_DRIVER_STATE", "/tmp/voice_driver_state.json")
TIMEOUT_S = float(os.environ.get("LIVE_VOICE_TIMEOUT", "220"))
HOSTED_POST_CALL_MARKER = os.environ.get("HOSTED_POST_CALL_MARKER", "")
GATEWAY_LOG = os.environ.get("GATEWAY_LOG", "")
POLL_EVERY_S = 6.0
HOSTED_SETTLEMENT_RESERVE_S = 55.0

pytestmark = pytest.mark.skipif(
    not (REMOTE_KEY and AUT_KEY and REAL),
    reason="voice suite: needs both keys + LIVE_REAL_MODEL=1",
)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _normalized_spoken_text(value: str | None) -> str:
    """Compare speech-carried text without punctuation/case artifacts."""
    return " ".join(re.findall(r"[a-z0-9]+", (value or "").casefold()))


def _voice_marker_key(value: str | None) -> str:
    """Normalize spacing variants such as xray, x-ray, and x ray."""
    return re.sub(r"\W+", "", value or "").casefold()


def _has_sms_send_intent(value: str | None) -> bool:
    """Recognize an SMS-send request after speech/API normalization."""
    normalized = _normalized_spoken_text(value)
    words = set(normalized.split())
    return "send" in words and (
        "sms" in words or "text message" in normalized
    )


def _action_item_field(item, name: str):
    """Read an action-item field from either SDK models or wire dictionaries."""
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def _matching_open_post_call_actions(call, marker: str) -> list:
    """Return open actions that carry this run's marker and SMS intent."""
    expected_marker = _voice_marker_key(marker)
    assert expected_marker
    matches = []
    for item in (getattr(call, "post_call_action_items", None) or []):
        raw_status = _action_item_field(item, "status") or ""
        status = getattr(raw_status, "value", raw_status)
        if str(status).casefold() != "open":
            continue
        action_text = " ".join(
            str(_action_item_field(item, field) or "")
            for field in ("action", "details")
        )
        if (
            expected_marker in _voice_marker_key(action_text)
            and _has_sms_send_intent(action_text)
        ):
            matches.append(item)
    return matches


def _post_call_action_diagnostics(
    call,
    marker: str,
) -> list[dict[str, bool | int]]:
    """Expose only non-content metadata needed to classify a mismatch."""
    expected_words = _normalized_spoken_text(marker).split()
    diagnostics = []
    for item in (getattr(call, "post_call_action_items", None) or []):
        raw_status = _action_item_field(item, "status") or ""
        status = getattr(raw_status, "value", raw_status)
        action = str(_action_item_field(item, "action") or "")
        details = str(_action_item_field(item, "details") or "")
        action_text = f"{action} {details}"
        action_words = set(_normalized_spoken_text(action_text).split())
        diagnostics.append({
            "open": str(status).casefold() == "open",
            "sms_intent": _has_sms_send_intent(action_text),
            "marker_words_present": sum(
                word in action_words for word in expected_words
            ),
            "marker_words_expected": len(expected_words),
            "action_length": len(action),
            "details_length": len(details),
        })
    return diagnostics


def _message_created_at(message) -> datetime | None:
    """Return an aware server timestamp from an SDK SMS row."""
    value = getattr(message, "created_at", None)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _saved_hosted_authority(client, identity_handle: str) -> str:
    """Read the server-owned authority default that this hosted call must snapshot."""
    identity = client.get_identity(identity_handle)
    config = identity.get_hosted_agent_config()
    raw = getattr(config, "authority_mode", "") or ""
    return str(getattr(raw, "value", raw)).casefold()


def _sms_target_numbers(message) -> set[str]:
    """All authoritative targets represented by an outbound SMS row."""
    values = [getattr(message, "remote_phone_number", "") or ""]
    for recipient in (getattr(message, "recipients", None) or []):
        if isinstance(recipient, dict):
            values.append(recipient.get("recipient_phone_number", "") or "")
        else:
            values.append(
                getattr(recipient, "recipient_phone_number", "") or ""
            )
    return {digits for value in values if (digits := _digits(value))}


def _client(key):
    from inkbox import Inkbox

    return Inkbox(api_key=key, base_url=BASE_URL)


def _driver_state() -> dict:
    with open(STATE_FILE) as fh:
        return json.load(fh)


def _gateway_log_text() -> str:
    """Read the captured gateway log used for deterministic live assertions."""
    if not GATEWAY_LOG:
        return ""
    try:
        with open(GATEWAY_LOG, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def _gateway_has_direct_contact_read(log_text: str, call_id) -> bool:
    """Match both console and structured log renderings for one exact call."""
    direct_read_marker = "realtime direct contact read inkbox_"
    call_marker = f"call_id={call_id}".casefold()
    for line in log_text.splitlines():
        folded = line.casefold()
        if direct_read_marker in folded and call_marker in folded:
            return True
    return False


def _aut_phone(aut) -> str:
    nums = aut.phone_numbers.list()
    assert nums, "AUT identity has no phone number"
    return nums[0].number


def _ensure_driver_allowed(aut, driver_number: str) -> None:
    """Allow the live driver through identity-level phone contact rules."""
    handle = aut.mailboxes.list()[0].email_address.split("@", 1)[0]
    rules = aut.phone_identity_contact_rules.list(handle)
    for rule in rules:
        if (
            getattr(rule, "match_target", "") == driver_number
            and str(getattr(rule, "action", "")).lower().endswith("allow")
            and str(getattr(rule, "status", "active")).lower().endswith("active")
        ):
            return
    aut.phone_identity_contact_rules.create(
        handle,
        action="allow",
        match_type="exact_number",
        match_target=driver_number,
    )


def _segments(remote, number_id, call_id):
    """Transcript segments for a call, split by who spoke."""
    # Identity-centered transcript read (SDK 0.4.15+); number_id is vestigial.
    segs = remote.calls.transcripts(call_id)
    rem = [s for s in segs if (getattr(s, "party", "") or "").lower() == "remote" and (s.text or "").strip()]
    loc = [s for s in segs if (getattr(s, "party", "") or "").lower() == "local" and (s.text or "").strip()]
    return segs, rem, loc


# A call can end normally and still never carry a conversation - answering-machine
# detection hanging up on the driver ends it `completed`, hangup_reason=voicemail.
# Transcript rows can still land during teardown, so allow a short grace period
# before giving up rather than polling a finished call for the full timeout.
TERMINAL_FAILURE_STATUSES = {"canceled", "failed"}
ENDED_STATUSES = {"completed"}
ENDED_GRACE_S = float(os.environ.get("LIVE_VOICE_ENDED_GRACE", "15"))


def _call_state(remote, call_id) -> tuple[str, str]:
    """Compact current call state for progress and terminal-failure output."""
    call = remote.calls.get(call_id)
    status = (getattr(call, "status", "") or "").lower()
    fields = (
        f"status={status!r}",
        f"hangup_reason={getattr(call, 'hangup_reason', None)!r}",
        f"started_at={getattr(call, 'started_at', None)!r}",
        f"ended_at={getattr(call, 'ended_at', None)!r}",
    )
    return status, " ".join(fields)


def _call_summary(call) -> str:
    """Return content-free call state for public failure diagnostics."""
    if call is None:
        return "missing"
    values = []
    for field in ("status", "hangup_reason"):
        value = getattr(call, field, None)
        value = getattr(value, "value", value)
        if value not in (None, ""):
            values.append(f"{field}={str(value)[:80]!r}")
    return " ".join(values) or "present"


def _wait_for_fresh_call_pair(
    driver_candidates,
    aut_candidates,
    before_driver: set,
    before_aut: set,
    *,
    not_before: datetime,
    deadline: float,
    label: str,
):
    """Return one stable, request-current record from each call owner."""
    stable_ids = None
    stable_since = None
    last_driver = None
    last_aut = None
    while time.monotonic() < deadline:
        fresh_driver = [
            call for call in driver_candidates() if call.id not in before_driver
        ]
        fresh_aut = [call for call in aut_candidates() if call.id not in before_aut]
        for call in (*fresh_driver, *fresh_aut):
            assert _message_created_at(call) is not None, (
                f"{label} fresh call records must carry server timestamps"
            )
        fresh_driver = [
            call
            for call in fresh_driver
            if _message_created_at(call) >= not_before
        ]
        fresh_aut = [
            call for call in fresh_aut if _message_created_at(call) >= not_before
        ]
        assert len(fresh_driver) <= 1, (
            f"{label} created duplicate driver call records"
        )
        assert len(fresh_aut) <= 1, f"{label} created duplicate AUT call records"
        last_driver = fresh_driver[0] if fresh_driver else None
        last_aut = fresh_aut[0] if fresh_aut else None
        if last_driver is not None and last_aut is not None:
            driver_created = _message_created_at(last_driver)
            aut_created = _message_created_at(last_aut)
            assert abs((driver_created - aut_created).total_seconds()) <= 60, (
                f"{label} call records are too far apart to be one call"
            )
            observed_ids = (last_driver.id, last_aut.id)
            if observed_ids != stable_ids:
                stable_ids = observed_ids
                stable_since = time.monotonic()
            elif (
                stable_since is not None
                and time.monotonic() - stable_since >= 2 * POLL_EVERY_S
            ):
                return last_driver, last_aut
        else:
            stable_ids = None
            stable_since = None
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        f"{label} did not produce exactly one stable call pair within "
        f"{TIMEOUT_S:.0f}s (driver={_call_summary(last_driver)}; "
        f"AUT={_call_summary(last_aut)})"
    )


def _assert_voicemail_disabled(call, context: str) -> None:
    """Prove a CI-created outbound call persisted the required policy."""
    raw = getattr(call, "voicemail_detection", "") or ""
    value = getattr(raw, "value", raw)
    assert str(value).casefold() == "disabled", (
        f"{context} must persist voicemail detection disabled, got {raw!r}"
    )


def _wait_for_two_way_call(remote, number_id, call_id, *, deadline=None):
    """Require two-way speech on the AUT-owned record and return agent speech."""
    deadline = deadline or (time.monotonic() + TIMEOUT_S)
    last = ""
    ended_at = None
    while time.monotonic() < deadline:
        transcript_state = ""
        try:
            _all, rem, loc = _segments(remote, number_id, call_id)
        except Exception as exc:  # transcripts may 404 until the call is set up
            rem, loc = [], []
            transcript_state = f"transcripts not ready: {type(exc).__name__}"
        if not transcript_state and rem and loc:
            agent_said = " | ".join(s.text.strip() for s in loc)
            return agent_said  # the agent reached the caller out loud, in a two-way call
        try:
            status, state = _call_state(remote, call_id)
        except Exception as exc:
            state = f"call state unavailable: {type(exc).__name__}"
            status = ""
        progress = transcript_state or f"segments so far: remote={len(rem)} local={len(loc)}"
        last = f"{progress}; {state}"
        if status in TERMINAL_FAILURE_STATUSES:
            pytest.fail(f"call ended before a two-way conversation ({last})")
        if status in ENDED_STATUSES:
            if ended_at is None:
                ended_at = time.monotonic()
            elif time.monotonic() - ended_at > ENDED_GRACE_S:
                pytest.fail(f"call ended without a two-way conversation ({last})")
        time.sleep(POLL_EVERY_S)
    pytest.fail(f"agent never held a two-way call within {TIMEOUT_S:.0f}s ({last})")


def _wait_for_driver_local_speech(remote, number_id, call_id, *, deadline):
    """Require the scripted caller's own speech on the driver-owned record."""
    last = "transcript not ready"
    while time.monotonic() < deadline:
        try:
            _all, _remote, local = _segments(remote, number_id, call_id)
            if local:
                return " | ".join(segment.text.strip() for segment in local)
            last = "driver-local segments=0"
        except Exception as exc:
            last = f"transcripts not ready: {type(exc).__name__}"
        try:
            status, state = _call_state(remote, call_id)
        except Exception as exc:
            status, state = "", f"call state unavailable: {type(exc).__name__}"
        if status in TERMINAL_FAILURE_STATUSES:
            pytest.fail(
                f"driver call ended before local speech persisted ({last}; {state})"
            )
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        f"driver-local speech did not persist within {TIMEOUT_S:.0f}s ({last})"
    )


def _aut_speech_mode(aut, call_id):
    """Speech flags from the exact call record owned by the AUT identity."""
    c = aut.calls.get(call_id)
    assert c.use_inkbox_tts is not None, "AUT call has no persisted speech mode"
    return c.use_inkbox_tts, c.use_inkbox_stt


def _outbound_texts_to(aut, aut_number_id, recipient_number):
    recipient = _digits(recipient_number)
    return [m for m in aut.texts.list(aut_number_id, limit=200)
            if (getattr(m, "direction", "") or "").lower() == "outbound"
            and recipient in _sms_target_numbers(m)]


def _wait_for_hosted_transcript_ready(
    remote, remote_number_id, call_id, marker, deadline, progress,
):
    """Require the persisted caller's post-call SMS intent on the driver leg."""
    expected_marker = _voice_marker_key(marker)
    assert expected_marker
    while time.monotonic() < deadline:
        progress["phase"] = "caller-intent transcript readiness"
        try:
            _all, _agent_segments, caller_segments = _segments(
                remote, remote_number_id, call_id,
            )
            caller_text = _normalized_spoken_text(
                " ".join(segment.text or "" for segment in caller_segments)
            )
            has_after_call = (
                "after we hang up" in caller_text
                or "after we hangup" in caller_text
            )
            has_sms_intent = "me" in caller_text.split() and _has_sms_send_intent(
                caller_text
            )
            has_marker = expected_marker in _voice_marker_key(caller_text)
            progress["last"] = (
                f"caller_segments={len(caller_segments)} "
                f"after_call={has_after_call} sms_intent={has_sms_intent} "
                f"marker={has_marker}"
            )
            if (
                has_after_call
                and has_sms_intent
                and has_marker
            ):
                return
        except Exception as exc:
            progress["last"] = f"transcripts not ready: {type(exc).__name__}"
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        "hosted voice test exhausted its budget before caller intent was persisted; "
        f"phase={progress['phase']} last={progress['last']}"
    )


def _wait_for_open_post_call_action(aut, call_id, marker, deadline, progress):
    """Gate hangup on the authoritative persisted open action item."""
    while time.monotonic() < deadline:
        progress["phase"] = "open post-call action persistence"
        try:
            call = aut.calls.get(call_id)
            items = getattr(call, "post_call_action_items", None) or []
            matches = _matching_open_post_call_actions(call, marker)
            progress["last"] = (
                f"open_action_items={len(items)} matching_sms_actions={len(matches)} "
                f"actions={_post_call_action_diagnostics(call, marker)!r}"
            )
            if matches:
                return
        except Exception as exc:
            progress["last"] = f"post-call actions not ready: {type(exc).__name__}"
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        "hosted voice test exhausted its budget before the current-run open "
        "post-call SMS action was persisted; "
        f"phase={progress['phase']} last={progress['last']}"
    )


def _wait_hosted_sms_settlement(
    aut,
    aut_number_id,
    remote_phone,
    before_ids,
    sms_watermark,
    call_id,
    deadline,
    progress,
):
    """Require one API-accepted exact-target SMS and completed host settlement."""
    assert HOSTED_POST_CALL_MARKER
    expected_marker = _voice_marker_key(HOSTED_POST_CALL_MARKER)
    duplicate_grace = 2 * POLL_EVERY_S
    settlement_deadline = deadline - duplicate_grace
    matches = []
    registry_entry = None
    while time.monotonic() < settlement_deadline:
        progress["phase"] = "post-call tool settlement"
        fresh = [m for m in _outbound_texts_to(aut, aut_number_id, remote_phone)
                 if m.id not in before_ids
                 and (created_at := _message_created_at(m)) is not None
                 and created_at >= sms_watermark]
        matches = [
            message for message in fresh
            if expected_marker in _voice_marker_key(
                getattr(message, "text", "") or ""
            )
        ]
        registry_path = os.path.expanduser("~/.openclaw/inkbox/hosted-call-completions.json")
        try:
            with open(registry_path) as fh:
                registry = json.load(fh)
            registry_entry = next(
                (entry for entry in registry.values()
                 if str(entry.get("callId", "")) == str(call_id)),
                None,
            )
        except (FileNotFoundError, json.JSONDecodeError):
            registry_entry = None
        registry_state = (
            str(registry_entry.get("state", "")) if registry_entry else "missing"
        )
        progress["last"] = (
            f"current_marker_rows={len(matches)} registry_state={registry_state!r}"
        )
        if len(matches) == 1 and registry_entry and registry_entry.get("state") == "completed":
            # The grace window is reserved before polling, so exact-one is
            # observed for its full duration without exceeding the shared
            # scenario budget.
            time.sleep(duplicate_grace)
            fresh = [m for m in _outbound_texts_to(aut, aut_number_id, remote_phone)
                     if m.id not in before_ids
                     and (created_at := _message_created_at(m)) is not None
                     and created_at >= sms_watermark]
            matches = [
                message for message in fresh
                if expected_marker in _voice_marker_key(
                    getattr(message, "text", "") or ""
                )
            ]
            assert len(matches) == 1, \
                f"hosted reconciliation sent {len(matches)} marker SMS messages; expected one"
            return
        if registry_entry and registry_entry.get("state") == "failed":
            pytest.fail("hosted SMS settlement failed")
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        "hosted voice test exhausted its budget before one API-accepted marker SMS "
        f"and completed host settlement; phase={progress['phase']} last={progress['last']}"
    )


def _hangup_call(client, call_id) -> None:
    """End a live test call through the control API, tolerating an ended race."""
    if not call_id:
        return
    try:
        client.calls.hangup(call_id)
        return
    except Exception:
        deadline = time.monotonic() + 10
        status = "unknown"
        while time.monotonic() < deadline:
            try:
                status = (getattr(client.calls.get(call_id), "status", "") or "").lower()
            except Exception:
                status = "unknown"
            if status in {"completed", "canceled", "failed"}:
                return
            time.sleep(0.5)
        raise RuntimeError(
            f"failed to hang up live test call; status={status!r}"
        ) from None


def _hangup_fresh_calls(client, candidates, baseline: set) -> None:
    """End every matching call that appeared after the scenario snapshot."""
    for call in candidates():
        if call.id not in baseline:
            _hangup_call(client, call.id)


def _sweep_matching_calls(client, candidates) -> None:
    """End matching calls left active by an interrupted earlier validation."""
    terminal = {"completed", "failed", "canceled"}

    def _status(call) -> str:
        raw = getattr(call, "status", "")
        return str(getattr(raw, "value", raw) or "").lower()

    existing = [call for call in candidates() if _status(call) not in terminal]
    for call in existing:
        _hangup_call(client, call.id)
    if not existing:
        return

    deadline = time.monotonic() + 30
    pending_statuses: list[str] = []
    while time.monotonic() < deadline:
        pending_statuses = []
        for call in existing:
            status = _status(client.calls.get(call.id))
            if status not in terminal:
                pending_statuses.append(status or "unknown")
        if not pending_statuses:
            return
        time.sleep(2)
    pytest.fail(
        "matching calls from an earlier validation did not end before setup "
        f"(pending_count={len(pending_statuses)} "
        f"statuses={sorted(set(pending_statuses))})"
    )


LOOKUP_CONTACT_GIVEN = "Olivia"
LOOKUP_CONTACT_FAMILY = "Parker"
LOOKUP_CONTACT_EMAIL = "olivia.parker.livetest@example.com"


def _delete_contacts_by_email(client, email: str) -> None:
    for contact in client.contacts.lookup(email=email) or []:
        contact_id = str(getattr(contact, "id", "") or "")
        if contact_id:
            client.contacts.delete(contact_id)


def _ensure_driver_is_a_known_contact(aut, driver_number: str) -> None:
    """Make the live caller eligible to receive third-party contact details."""
    if aut.contacts.lookup(phone=driver_number):
        return
    from inkbox.contacts.types import ContactPhone

    aut.contacts.create(
        given_name="Penny",
        family_name="Tester",
        phones=[ContactPhone(label="mobile", value=driver_number)],
    )


@pytest.mark.skipif(SCENARIO != "inbound_inkbox", reason="inbound Inkbox STT/TTS leg only")
def test_inbound_call_inkbox_tts_stt():
    """Driver calls the agent; the agent answers via Inkbox STT/TTS and replies."""
    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_phone = _aut_phone(aut)
    aut_tail = _digits(aut_phone)[-10:]
    driver_tail = _digits(st["number"])[-10:]

    def _driver_outbound():
        return [
            candidate
            for candidate in remote.calls.list(limit=200)
            if (getattr(candidate, "direction", "") or "").lower()
            == "outbound"
            and _digits(getattr(candidate, "remote_phone_number", "") or "")[-10:]
            == aut_tail
        ]

    def _aut_inbound():
        return [
            candidate
            for candidate in aut.calls.list(limit=200)
            if (getattr(candidate, "direction", "") or "").lower() == "inbound"
            and _digits(getattr(candidate, "remote_phone_number", "") or "")[-10:]
            == driver_tail
        ]

    # Server-side contact rules run before the plugin or its local allow-all
    # setting. Whitelisted smoke identities therefore need the driver allowed
    # explicitly or the call is rejected before either media WS connects.
    _ensure_driver_allowed(aut, st["number"])

    # Place the call once after clearing only matching active test calls.
    _sweep_matching_calls(remote, _driver_outbound)
    _sweep_matching_calls(aut, _aut_inbound)
    before_aut = {candidate.id for candidate in _aut_inbound()}
    not_before = datetime.now(timezone.utc) - timedelta(seconds=10)
    call = remote.calls.place(
        from_number=st["number"],
        to_number=aut_phone,
        client_websocket_url=st["ws_url"],
        voicemail_detection="disabled",
    )
    try:
        deadline = time.monotonic() + TIMEOUT_S
        _driver_call, aut_call = _wait_for_fresh_call_pair(
            lambda: [remote.calls.get(call.id)],
            _aut_inbound,
            set(),
            before_aut,
            not_before=not_before,
            deadline=deadline,
            label="inbound voice test",
        )
        _wait_for_driver_local_speech(
            remote, st["number_id"], call.id, deadline=deadline
        )
        agent_said = _wait_for_two_way_call(
            aut, "unused", aut_call.id, deadline=deadline
        )
        assert agent_said, "agent produced no speech on the inbound call"
        _assert_voicemail_disabled(
            remote.calls.get(call.id), "inbound voice driver call"
        )

        tts, stt = _aut_speech_mode(aut, aut_call.id)
        assert tts and stt, f"inbound call should run Inkbox STT/TTS, got tts={tts} stt={stt}"
    finally:
        _hangup_call(remote, call.id)
        _hangup_fresh_calls(aut, _aut_inbound, before_aut)


@pytest.mark.skipif(SCENARIO != "outbound_realtime", reason="outbound realtime leg only")
def test_outbound_call_realtime():
    """Driver texts 'call me'; the agent places a realtime-powered call and replies."""
    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_phone = _aut_phone(aut)
    tail = _digits(aut_phone)[-10:]

    def _inbound_from_aut():
        return [c for c in remote.calls.list(limit=200)
                if (getattr(c, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]

    driver_tail = _digits(st["number"])[-10:]

    def _aut_outbound_to_driver():
        return [c for c in aut.calls.list(limit=200)
                if (getattr(c, "direction", "") or "").lower() == "outbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == driver_tail]

    _sweep_matching_calls(remote, _inbound_from_aut)
    _sweep_matching_calls(aut, _aut_outbound_to_driver)
    before = {c.id for c in _inbound_from_aut()}
    before_aut = {c.id for c in _aut_outbound_to_driver()}
    not_before = datetime.now(timezone.utc) - timedelta(seconds=10)
    remote.texts.send(st["number_id"], to=aut_phone, text=_call_me_text())

    try:
        deadline = time.monotonic() + TIMEOUT_S
        driver_call, aut_call = _wait_for_fresh_call_pair(
            _inbound_from_aut,
            _aut_outbound_to_driver,
            before,
            before_aut,
            not_before=not_before,
            deadline=deadline,
            label="outbound realtime voice test",
        )
        _wait_for_driver_local_speech(
            remote, st["number_id"], driver_call.id, deadline=deadline
        )
        agent_said = _wait_for_two_way_call(
            aut, "unused", aut_call.id, deadline=deadline
        )
        assert agent_said, "agent produced no speech on the outbound call"

        tts, stt = _aut_speech_mode(aut, aut_call.id)
        assert tts is False and stt is False, \
            f"outbound call must be powered by the realtime API (Inkbox speech off), got tts={tts} stt={stt}"
        _assert_voicemail_disabled(aut_call, "outbound realtime call")
    finally:
        _hangup_fresh_calls(remote, _inbound_from_aut, before)
        _hangup_fresh_calls(aut, _aut_outbound_to_driver, before_aut)


@pytest.mark.skipif(
    SCENARIO != "outbound_realtime_contact",
    reason="outbound realtime contact-read leg only",
)
def test_outbound_call_realtime_direct_contact_lookup():
    """Realtime serves a seeded contact detail through the direct read tool."""
    from inkbox.contacts.types import ContactEmail

    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_phone = _aut_phone(aut)
    aut_tail = _digits(aut_phone)[-10:]
    driver_tail = _digits(st["number"])[-10:]

    _ensure_driver_is_a_known_contact(aut, st["number"])
    _delete_contacts_by_email(aut, LOOKUP_CONTACT_EMAIL)
    aut.contacts.create(
        given_name=LOOKUP_CONTACT_GIVEN,
        family_name=LOOKUP_CONTACT_FAMILY,
        emails=[ContactEmail(label="work", value=LOOKUP_CONTACT_EMAIL)],
    )
    try:
        def _driver_inbound():
            return [c for c in remote.calls.list(limit=200)
                    if (getattr(c, "direction", "") or "").lower() == "inbound"
                    and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == aut_tail]

        def _aut_outbound():
            return [c for c in aut.calls.list(limit=200)
                    if (getattr(c, "direction", "") or "").lower() == "outbound"
                    and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == driver_tail]

        def _recite_from_aut(call_id) -> str:
            try:
                segments = aut.calls.transcripts(call_id)
            except Exception:
                return ""
            transcript = " ".join(
                (segment.text or "").strip()
                for segment in segments
                if (segment.text or "").strip()
            )
            squashed = transcript.casefold().replace(" ", "")
            if LOOKUP_CONTACT_FAMILY.casefold() in squashed and "example" in squashed:
                return transcript
            return ""

        _sweep_matching_calls(remote, _driver_inbound)
        _sweep_matching_calls(aut, _aut_outbound)
        before_driver = {call.id for call in _driver_inbound()}
        before_aut = {call.id for call in _aut_outbound()}
        not_before = datetime.now(timezone.utc) - timedelta(seconds=10)
        remote.texts.send(st["number_id"], to=aut_phone, text=_call_me_text())

        recite = ""
        try:
            deadline = time.monotonic() + TIMEOUT_S
            driver_call, aut_call = _wait_for_fresh_call_pair(
                _driver_inbound,
                _aut_outbound,
                before_driver,
                before_aut,
                not_before=not_before,
                deadline=deadline,
                label="realtime contact voice test",
            )
            _assert_voicemail_disabled(aut_call, "outbound realtime contact call")
            _wait_for_driver_local_speech(
                remote, st["number_id"], driver_call.id, deadline=deadline
            )
            agent_said = _wait_for_two_way_call(
                aut, "unused", aut_call.id, deadline=deadline
            )
            assert agent_said, "agent produced no speech on the contact-lookup call"

            while time.monotonic() < deadline:
                recite = _recite_from_aut(aut_call.id)
                if recite and _gateway_has_direct_contact_read(
                    _gateway_log_text(), aut_call.id
                ):
                    break
                time.sleep(POLL_EVERY_S)

            assert _gateway_has_direct_contact_read(
                _gateway_log_text(), aut_call.id
            ), "gateway state shows no direct contact read on the current AUT call"
            assert recite, (
                "the AUT call transcript did not persist the requested contact details"
            )
            tts, stt = _aut_speech_mode(aut, aut_call.id)
            assert tts is False and stt is False, (
                "realtime contact call must persist Inkbox speech disabled"
            )
        finally:
            _hangup_fresh_calls(remote, _driver_inbound, before_driver)
            _hangup_fresh_calls(aut, _aut_outbound, before_aut)
    finally:
        _delete_contacts_by_email(aut, LOOKUP_CONTACT_EMAIL)


@pytest.mark.skipif(SCENARIO != "outbound_hosted", reason="outbound Inkbox Voice AI leg only")
def test_outbound_call_hosted_and_settles_sms_once():
    """Voice AI calls, then OpenClaw proves the exact post-call SMS tool outcome."""
    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_numbers = aut.phone_numbers.list()
    assert aut_numbers, "AUT identity has no phone number"
    aut_number = aut_numbers[0]
    aut_phone = aut_number.number
    tail = _digits(aut_phone)[-10:]
    progress = {"phase": "baseline", "last": ""}
    deadline = time.monotonic() + TIMEOUT_S
    action_gate_deadline = deadline - (
        HOSTED_SETTLEMENT_RESERVE_S + 2 * POLL_EVERY_S
    )

    def _inbound_calls_from_aut():
        return [c for c in remote.calls.list(limit=200)
                if (getattr(c, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]

    driver_tail = _digits(st["number"])[-10:]

    def _outbound_calls_to_driver():
        return [c for c in aut.calls.list(limit=200)
                if (getattr(c, "direction", "") or "").lower() == "outbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == driver_tail]

    assert HOSTED_POST_CALL_MARKER, (
        "HOSTED_POST_CALL_MARKER is required for the hosted voice leg"
    )
    _sweep_matching_calls(remote, _inbound_calls_from_aut)
    _sweep_matching_calls(aut, _outbound_calls_to_driver)
    baseline_remote_calls = _inbound_calls_from_aut()
    baseline_aut_calls = _outbound_calls_to_driver()
    before_calls = {c.id for c in baseline_remote_calls}
    before_aut_calls = {c.id for c in baseline_aut_calls}
    baseline_texts = _outbound_texts_to(
        aut, str(aut_number.id), st["number"],
    )
    before_texts = {message.id for message in baseline_texts}
    baseline_times = [
        created_at for message in baseline_texts
        if (created_at := _message_created_at(message)) is not None
    ]
    sms_watermark = max(
        baseline_times,
        default=datetime.min.replace(tzinfo=timezone.utc),
    )
    identity_handle = aut.mailboxes.list()[0].email_address.split("@", 1)[0]
    expected_authority = _saved_hosted_authority(aut, identity_handle)
    assert expected_authority in {"contact_scoped", "yolo"}, (
        f"unexpected saved hosted authority {expected_authority!r}"
    )
    not_before = datetime.now(timezone.utc) - timedelta(seconds=10)
    remote.texts.send(
        st["number_id"],
        to=aut_phone,
        text=(
            "Use inkbox_place_call to call me now. Inkbox Voice AI must handle the call. "
            "The purpose is to complete my spoken request and record any post-call action. "
            f"Do not text before calling. Request ref {uuid.uuid4().hex[:6]}."
        ),
    )

    remote_call_id = None
    aut_call_id = None
    try:
        progress["phase"] = "hosted call placement"
        driver_call, aut_call = _wait_for_fresh_call_pair(
            _inbound_calls_from_aut,
            _outbound_calls_to_driver,
            before_calls,
            before_aut_calls,
            not_before=not_before,
            deadline=action_gate_deadline,
            label="hosted voice test",
        )
        remote_call_id = driver_call.id
        aut_call_id = aut_call.id

        # An outbound hosted call produces two records with different owners:
        # the AUT's outbound record captures who drove the call, while the
        # driver's inbound record captures its own client WebSocket answer
        # path. Assert the mode and reconcile completion against the AUT record.
        call = aut.calls.get(aut_call_id)
        raw_mode = getattr(call, "mode", "") or ""
        mode = getattr(raw_mode, "value", raw_mode)
        assert str(mode).lower() == "hosted_agent", \
            f"expected hosted_agent mode, got {raw_mode!r}"
        _assert_voicemail_disabled(call, "outbound hosted call")
        assert getattr(call, "reason", None), "hosted call must persist a task reason"
        raw_authority = getattr(call, "hosted_agent_authority_mode", "") or ""
        actual_authority = str(getattr(raw_authority, "value", raw_authority)).casefold()
        assert actual_authority == expected_authority, (
            "hosted call authority snapshot does not match the saved agent default: "
            f"saved={expected_authority!r} call={actual_authority!r}"
        )
        _wait_for_driver_local_speech(
            remote,
            st["number_id"],
            remote_call_id,
            deadline=action_gate_deadline,
        )
        agent_said = _wait_for_two_way_call(
            aut, "unused", aut_call_id, deadline=action_gate_deadline
        )
        assert agent_said, "Voice AI produced no speech"
        _wait_for_hosted_transcript_ready(
            remote,
            st["number_id"],
            remote_call_id,
            HOSTED_POST_CALL_MARKER,
            action_gate_deadline,
            progress,
        )
        _wait_for_open_post_call_action(
            aut,
            aut_call_id,
            HOSTED_POST_CALL_MARKER,
            action_gate_deadline,
            progress,
        )

    finally:
        _hangup_fresh_calls(remote, _inbound_calls_from_aut, before_calls)
        _hangup_fresh_calls(aut, _outbound_calls_to_driver, before_aut_calls)

    # The contract ends at the synchronous API-accepted tool result. Carrier
    # delivery is asynchronous and is already exercised by the channel suite.
    _wait_hosted_sms_settlement(
        aut,
        str(aut_number.id),
        st["number"],
        before_texts,
        sms_watermark,
        aut_call_id,
        deadline,
        progress,
    )
