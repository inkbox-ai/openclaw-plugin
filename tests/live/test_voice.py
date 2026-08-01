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
from datetime import datetime, timezone

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
RECITE_GRACE_S = 24.0

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
        f"reason={getattr(call, 'reason', None)!r}",
        f"hangup_reason={getattr(call, 'hangup_reason', None)!r}",
        f"started_at={getattr(call, 'started_at', None)!r}",
        f"ended_at={getattr(call, 'ended_at', None)!r}",
    )
    return status, " ".join(fields)


def _assert_voicemail_disabled(call, context: str) -> None:
    """Prove a CI-created outbound call persisted the required policy."""
    raw = getattr(call, "voicemail_detection", "") or ""
    value = getattr(raw, "value", raw)
    assert str(value).casefold() == "disabled", (
        f"{context} must persist voicemail detection disabled, got {raw!r}"
    )


def _wait_for_two_way_call(remote, number_id, call_id):
    """Block until the call transcript shows BOTH the agent and the driver spoke."""
    deadline = time.monotonic() + TIMEOUT_S
    last = ""
    ended_at = None
    while time.monotonic() < deadline:
        transcript_state = ""
        try:
            _all, rem, loc = _segments(remote, number_id, call_id)
        except Exception as exc:  # transcripts may 404 until the call is set up
            rem, loc = [], []
            transcript_state = f"transcripts not ready: {exc!r}"
        if not transcript_state and rem and loc:
            agent_said = " | ".join(s.text.strip() for s in rem)
            return agent_said  # the agent reached the caller out loud, in a two-way call
        try:
            status, state = _call_state(remote, call_id)
        except Exception as exc:
            state = f"call state unavailable: {exc!r}"
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


def _aut_speech_mode(aut, direction, driver_number):
    """(use_inkbox_tts, use_inkbox_stt) of the agent's most recent answered call
    in `direction` with the driver. Tells Inkbox STT/TTS (True/True) from realtime
    (False/False), so each leg can prove it ran the speech path it claims."""
    tail = _digits(driver_number)[-10:]
    answered = [c for c in aut.calls.list(limit=10)
                if (getattr(c, "direction", "") or "").lower() == direction
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail
                and c.use_inkbox_tts is not None]
    assert answered, f"no answered {direction} agent call with the driver found"
    c = answered[0]  # newest first
    return c.use_inkbox_tts, c.use_inkbox_stt


def _outbound_texts_to(aut, aut_number_id, recipient_number):
    recipient = _digits(recipient_number)
    return [m for m in aut.texts.list(aut_number_id, limit=200)
            if (getattr(m, "direction", "") or "").lower() == "outbound"
            and recipient in _sms_target_numbers(m)]


def _wait_for_hosted_transcript_ready(
    remote, remote_number_id, call_id, marker, deadline, progress,
):
    """Require agent speech plus the persisted caller's post-call SMS intent."""
    expected_marker = _voice_marker_key(marker)
    assert expected_marker
    while time.monotonic() < deadline:
        progress["phase"] = "caller-intent transcript readiness"
        try:
            _all, agent_segments, caller_segments = _segments(
                remote, remote_number_id, call_id,
            )
            caller_text = _normalized_spoken_text(
                " ".join(segment.text or "" for segment in caller_segments)
            )
            progress["last"] = (
                f"agent_segments={len(agent_segments)} caller={caller_text!r}"
            )
            has_after_call = (
                "after we hang up" in caller_text
                or "after we hangup" in caller_text
            )
            has_sms_intent = "me" in caller_text.split() and _has_sms_send_intent(
                caller_text
            )
            if (
                agent_segments
                and has_after_call
                and has_sms_intent
                and expected_marker in _voice_marker_key(caller_text)
            ):
                return
        except Exception as exc:
            progress["last"] = f"transcripts not ready: {exc!r}"
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
                f"open_action_items={len(items)} matching_sms_actions={len(matches)}"
            )
            if matches:
                return
        except Exception as exc:
            progress["last"] = f"post-call actions not ready: {exc!r}"
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
        progress["last"] = (
            f"current_marker_rows={len(matches)} registry={registry_entry!r}"
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
            pytest.fail(f"hosted SMS settlement failed: {registry_entry!r}")
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
    except Exception as hangup_error:
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
            f"failed to hang up live test call {call_id}; status={status!r}"
        ) from hangup_error


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

    # Server-side contact rules run before the plugin or its local allow-all
    # setting. Whitelisted smoke identities therefore need the driver allowed
    # explicitly or the call is rejected before either media WS connects.
    _ensure_driver_allowed(aut, st["number"])

    # Place the call to the agent, handing Inkbox the driver's own media WS.
    call = remote.calls.place(
        from_number=st["number"],
        to_number=aut_phone,
        client_websocket_url=st["ws_url"],
        voicemail_detection="disabled",
    )
    try:
        agent_said = _wait_for_two_way_call(remote, st["number_id"], call.id)
        assert agent_said, "agent produced no speech on the inbound call"
        _assert_voicemail_disabled(
            remote.calls.get(call.id), "inbound voice driver call"
        )

        tts, stt = _aut_speech_mode(aut, "inbound", st["number"])
        assert tts and stt, f"inbound call should run Inkbox STT/TTS, got tts={tts} stt={stt}"
    finally:
        _hangup_call(remote, call.id)


@pytest.mark.skipif(SCENARIO != "outbound_realtime", reason="outbound realtime leg only")
def test_outbound_call_realtime():
    """Driver texts 'call me'; the agent places a realtime-powered call and replies."""
    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_phone = _aut_phone(aut)
    tail = _digits(aut_phone)[-10:]

    def _inbound_from_aut():
        return [c for c in remote.calls.list(limit=30)
                if (getattr(c, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]

    driver_tail = _digits(st["number"])[-10:]

    def _aut_outbound_to_driver():
        return [c for c in aut.calls.list(limit=30)
                if (getattr(c, "direction", "") or "").lower() == "outbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == driver_tail]

    before = {c.id for c in _inbound_from_aut()}
    before_aut = {c.id for c in _aut_outbound_to_driver()}
    remote.texts.send(st["number_id"], to=aut_phone, text=_call_me_text())

    call_id = None
    try:
        # Wait for the agent to dial back, then verify the call transcript.
        deadline = time.monotonic() + TIMEOUT_S
        while time.monotonic() < deadline:
            fresh = [c for c in _inbound_from_aut() if c.id not in before]
            if fresh:
                call_id = fresh[0].id
                break
            time.sleep(POLL_EVERY_S)
        assert call_id, f"agent never placed a call back within {TIMEOUT_S:.0f}s"

        agent_said = _wait_for_two_way_call(remote, st["number_id"], call_id)
        assert agent_said, "agent produced no speech on the outbound call"

        fresh_aut = [
            call for call in _aut_outbound_to_driver() if call.id not in before_aut
        ]
        assert fresh_aut, "no fresh AUT outbound realtime call record found"
        aut_call = fresh_aut[0]
        tts, stt = aut_call.use_inkbox_tts, aut_call.use_inkbox_stt
        assert tts is False and stt is False, \
            f"outbound call must be powered by the realtime API (Inkbox speech off), got tts={tts} stt={stt}"
        _assert_voicemail_disabled(aut_call, "outbound realtime call")
    finally:
        _hangup_call(remote, call_id)


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

        def _spoken_contact(reads) -> str:
            for client, call_id in reads:
                try:
                    segments = client.calls.transcripts(call_id)
                except Exception:
                    continue
                transcript = " ".join(
                    (segment.text or "").strip()
                    for segment in segments
                    if (segment.text or "").strip()
                )
                squashed = transcript.casefold().replace(" ", "")
                if LOOKUP_CONTACT_FAMILY.casefold() in squashed and "example" in squashed:
                    return transcript
            return ""

        attempt_timeout = max(TIMEOUT_S / 2, 110.0)
        recite = ""
        aut_calls = {}
        proven_aut_call = None
        call_legs = []
        attempt_states = []
        attempt_error = ""
        direct_read_marker = "Inkbox realtime direct contact read inkbox_"

        def _direct_read_seen(call) -> bool:
            if call is None:
                return False
            call_marker = f"call_id={call.id}"
            return any(
                direct_read_marker in line and call_marker in line
                for line in _gateway_log_text().splitlines()
            )

        for _attempt in (1, 2):
            before_aut = {call.id for call in _aut_outbound()}
            before_driver = {call.id for call in _driver_inbound()}
            ref = uuid.uuid4().hex[:6]
            remote.texts.send(
                st["number_id"],
                to=aut_phone,
                text=f"{_call_me_text()} (attempt {_attempt}, ref {ref})",
            )

            deadline = time.monotonic() + attempt_timeout
            log_seen_at = None
            fresh_aut = []
            fresh_driver = []
            while time.monotonic() < deadline:
                fresh_aut = [call for call in _aut_outbound() if call.id not in before_aut]
                fresh_driver = [
                    call for call in _driver_inbound() if call.id not in before_driver
                ]
                if len(fresh_aut) > 1 or len(fresh_driver) > 1:
                    attempt_error = (
                        f"realtime contact attempt {_attempt} ref={ref} created "
                        f"duplicate legs: driver={len(fresh_driver)} "
                        f"aut={len(fresh_aut)}"
                    )
                    break
                if fresh_aut:
                    for call in fresh_aut:
                        aut_calls[str(call.id)] = call
                for owner, call in (
                    [(aut, call) for call in fresh_aut]
                    + [(remote, call) for call in fresh_driver]
                ):
                    if not any(
                        existing_owner is owner and existing_id == call.id
                        for existing_owner, existing_id in call_legs
                    ):
                        call_legs.append((owner, call.id))
                recite = recite or _spoken_contact(call_legs)
                proven_aut_call = next(
                    (
                        call for call in aut_calls.values()
                        if _direct_read_seen(call)
                    ),
                    None,
                )
                if proven_aut_call is not None:
                    if log_seen_at is None:
                        log_seen_at = time.monotonic()
                    if recite or time.monotonic() - log_seen_at >= RECITE_GRACE_S:
                        break
                time.sleep(POLL_EVERY_S)
            attempt_states.append(
                f"attempt={_attempt} ref={ref} "
                f"driver={len(fresh_driver)} aut={len(fresh_aut)}"
            )
            if attempt_error:
                break
            if proven_aut_call is not None:
                break
            if fresh_aut or fresh_driver:
                # A call happened but the direct contact read did not. That is
                # a call/tool defect, not an empty model turn; another external
                # call would hide it and could dial the user twice.
                break

        for client, call_id in call_legs:
            _hangup_call(client, call_id)

        if not recite and call_legs:
            end_deadline = time.monotonic() + 30.0
            while time.monotonic() < end_deadline and not recite:
                recite = _spoken_contact(call_legs)
                if not recite:
                    time.sleep(POLL_EVERY_S)

        assert not attempt_error, attempt_error
        assert proven_aut_call is not None, (
            "no fresh AUT realtime call produced a correlated direct contact "
            f"read: {'; '.join(attempt_states)}"
        )
        _assert_voicemail_disabled(
            proven_aut_call, "outbound realtime contact call"
        )
        assert (
            proven_aut_call.use_inkbox_tts is False
            and proven_aut_call.use_inkbox_stt is False
        ), (
            "realtime contact call must persist Inkbox speech disabled"
        )
        assert _direct_read_seen(proven_aut_call), (
            "gateway logs show no direct realtime contact read during the call"
        )
        if recite:
            print(f"realtime contact recite captured: {recite[:160]!r}")
        else:
            print(
                "direct contact read succeeded; final spoken recite did not persist "
                "before call teardown (best-effort transcript diagnostic)"
            )
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

    def _inbound_calls_from_aut():
        return [c for c in remote.calls.list(limit=30)
                if (getattr(c, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]

    driver_tail = _digits(st["number"])[-10:]

    def _outbound_calls_to_driver():
        return [c for c in aut.calls.list(limit=30)
                if (getattr(c, "direction", "") or "").lower() == "outbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == driver_tail]

    assert HOSTED_POST_CALL_MARKER, (
        "HOSTED_POST_CALL_MARKER is required for the hosted voice leg"
    )
    before_calls = {c.id for c in _inbound_calls_from_aut()}
    before_aut_calls = {c.id for c in _outbound_calls_to_driver()}
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
        while time.monotonic() < deadline:
            progress["phase"] = "hosted call placement"
            fresh_remote = [c for c in _inbound_calls_from_aut() if c.id not in before_calls]
            fresh_aut = [c for c in _outbound_calls_to_driver() if c.id not in before_aut_calls]
            progress["last"] = (
                f"driver_records={len(fresh_remote)} aut_records={len(fresh_aut)}"
            )
            if fresh_remote and fresh_aut:
                remote_call_id = fresh_remote[0].id
                aut_call_id = fresh_aut[0].id
                break
            time.sleep(POLL_EVERY_S)
        assert remote_call_id and aut_call_id, (
            "agent never placed a hosted call before the shared budget expired; "
            f"phase={progress['phase']} last={progress['last']}"
        )

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
        assert getattr(call, "hosted_agent_authority_mode", None) is not None
        _wait_for_hosted_transcript_ready(
            remote,
            st["number_id"],
            remote_call_id,
            HOSTED_POST_CALL_MARKER,
            deadline,
            progress,
        )
        _wait_for_open_post_call_action(
            aut,
            aut_call_id,
            HOSTED_POST_CALL_MARKER,
            deadline,
            progress,
        )

    finally:
        _hangup_call(remote, remote_call_id)

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
