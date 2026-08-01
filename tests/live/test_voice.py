"""Live voice-call suite — real phone calls, real model, transcript-verified.

Three scenarios, each run against a gateway booted in the matching speech mode (the
workflow sets that up and selects the scenario via VOICE_SCENARIO):

  * inbound_inkbox   — the driver calls the agent; the agent answers with Inkbox
                       STT/TTS and holds a turn.
  * outbound_realtime — the driver texts "call me"; the agent places a call back,
                       powered by the realtime API, and holds a turn.
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
HOSTED_SMS_MARKER = os.environ.get("HOSTED_SMS_MARKER", "")
POLL_EVERY_S = 6.0

pytestmark = pytest.mark.skipif(
    not (REMOTE_KEY and AUT_KEY and REAL),
    reason="voice suite: needs both keys + LIVE_REAL_MODEL=1",
)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _client(key):
    from inkbox import Inkbox

    return Inkbox(api_key=key, base_url=BASE_URL)


def _driver_state() -> dict:
    with open(STATE_FILE) as fh:
        return json.load(fh)


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


def _inbound_texts_from(remote, remote_number_id, sender_number):
    tail = _digits(sender_number)[-10:]
    return [m for m in remote.texts.list(remote_number_id, limit=30)
            if (getattr(m, "direction", "") or "").lower() == "inbound"
            and _digits(getattr(m, "remote_phone_number", "") or "")[-10:] == tail]


def _wait_hosted_sms_settlement(remote, remote_number_id, aut_phone, before_ids, call_id):
    """Require recipient delivery and the plugin's durable host-hook success marker."""
    assert HOSTED_SMS_MARKER, "HOSTED_SMS_MARKER is required for the hosted voice leg"
    deadline = time.monotonic() + TIMEOUT_S
    matches = []
    registry_entry = None
    while time.monotonic() < deadline:
        fresh = [m for m in _inbound_texts_from(remote, remote_number_id, aut_phone)
                 if m.id not in before_ids]
        matches = [m for m in fresh if HOSTED_SMS_MARKER in (getattr(m, "text", "") or "")]
        registry_path = os.path.expanduser("~/.openclaw/inkbox/hosted-call-completions.json")
        try:
            with open(registry_path) as fh:
                registry = json.load(fh)
            registry_entry = next(
                (entry for entry in registry.values()
                 if str(entry.get("callId", "")) == call_id),
                None,
            )
        except (FileNotFoundError, json.JSONDecodeError):
            registry_entry = None
        if len(matches) == 1 and registry_entry and registry_entry.get("state") == "completed":
            # Let an accidental duplicate settle before asserting exact-one.
            time.sleep(2 * POLL_EVERY_S)
            fresh = [m for m in _inbound_texts_from(remote, remote_number_id, aut_phone)
                     if m.id not in before_ids]
            matches = [m for m in fresh
                       if HOSTED_SMS_MARKER in (getattr(m, "text", "") or "")]
            assert len(matches) == 1, \
                f"hosted reconciliation sent {len(matches)} marker SMS messages; expected one"
            return
        if registry_entry and registry_entry.get("state") == "failed":
            pytest.fail(f"hosted SMS settlement failed: {registry_entry!r}")
        time.sleep(POLL_EVERY_S)
    pytest.fail(
        "hosted reconciliation did not produce one delivered marker SMS and a completed "
        f"host settlement within {TIMEOUT_S:.0f}s; matches={len(matches)} registry={registry_entry!r}"
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

    before = {c.id for c in _inbound_from_aut()}
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

        tts, stt = _aut_speech_mode(aut, "outbound", st["number"])
        assert tts is False and stt is False, \
            f"outbound call must be powered by the realtime API (Inkbox speech off), got tts={tts} stt={stt}"
    finally:
        _hangup_call(remote, call_id)


@pytest.mark.skipif(SCENARIO != "outbound_hosted", reason="outbound Inkbox Voice AI leg only")
def test_outbound_call_hosted_and_settles_sms_once():
    """Voice AI calls, then OpenClaw proves the exact post-call SMS tool outcome."""
    st = _driver_state()
    remote, aut = _client(REMOTE_KEY), _client(AUT_KEY)
    aut_phone = _aut_phone(aut)
    tail = _digits(aut_phone)[-10:]

    def _inbound_calls_from_aut():
        return [c for c in remote.calls.list(limit=30)
                if (getattr(c, "direction", "") or "").lower() == "inbound"
                and _digits(getattr(c, "remote_phone_number", "") or "")[-10:] == tail]

    before_calls = {c.id for c in _inbound_calls_from_aut()}
    before_texts = {m.id for m in _inbound_texts_from(remote, st["number_id"], aut_phone)}
    remote.texts.send(
        st["number_id"],
        to=aut_phone,
        text=(
            "Use inkbox_place_call to call me now. Inkbox Voice AI must handle the call. "
            "The purpose is to complete my spoken request and record any post-call action. "
            f"Do not text before calling. Request ref {uuid.uuid4().hex[:6]}."
        ),
    )

    call_id = None
    try:
        deadline = time.monotonic() + TIMEOUT_S
        while time.monotonic() < deadline:
            fresh = [c for c in _inbound_calls_from_aut() if c.id not in before_calls]
            if fresh:
                call_id = fresh[0].id
                break
            time.sleep(POLL_EVERY_S)
        assert call_id, f"agent never placed a hosted call within {TIMEOUT_S:.0f}s"

        call = remote.calls.get(call_id)
        assert (getattr(call, "mode", "") or "").lower() == "hosted_agent", \
            f"expected hosted_agent mode, got {getattr(call, 'mode', None)!r}"
        agent_said = _wait_for_two_way_call(remote, st["number_id"], call_id)
        assert agent_said, "Inkbox Voice AI produced no speech on the outbound call"

        # The driver hangs up after its scripted request. Wait for the durable
        # post-call webhook reconciliation and its recipient-visible side effect.
        _wait_hosted_sms_settlement(
            remote, st["number_id"], aut_phone, before_texts, call_id,
        )
    finally:
        _hangup_call(remote, call_id)
