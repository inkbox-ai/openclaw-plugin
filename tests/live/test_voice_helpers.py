"""Focused contracts for live voice ownership and correlation."""

import inspect
from pathlib import Path
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import test_voice as voice
import voice_marker


class _Calls:
    def __init__(self, segments=()):
        self._segments = list(segments)
        self.hung_up = []

    def transcripts(self, _call_id):
        return self._segments

    def hangup(self, call_id):
        self.hung_up.append(call_id)


def _segment(party: str, text: str):
    return SimpleNamespace(party=party, text=text)


def _call(call_id: str, created_at: datetime):
    return SimpleNamespace(id=call_id, created_at=created_at)


def test_two_way_proof_returns_aut_local_speech():
    aut = SimpleNamespace(calls=_Calls([
        _segment("remote", "driver request"),
        _segment("local", "agent reply"),
    ]))

    assert voice._wait_for_two_way_call(aut, "unused", "aut-call") == "agent reply"


def test_driver_proof_requires_driver_local_speech():
    driver = SimpleNamespace(calls=_Calls([
        _segment("local", "driver request"),
        _segment("remote", "agent reply"),
    ]))

    assert voice._wait_for_driver_local_speech(
        driver,
        "unused",
        "driver-call",
        deadline=voice.time.monotonic() + 1,
    ) == "driver request"


def test_fresh_pair_requires_one_call_per_owner_and_close_timestamps(monkeypatch):
    monkeypatch.setattr(voice, "POLL_EVERY_S", 0)
    created_at = datetime.now(timezone.utc)
    driver = _call("driver-new", created_at)
    aut = _call("aut-new", created_at)

    assert voice._wait_for_fresh_call_pair(
        lambda: [driver],
        lambda: [aut],
        {"driver-old"},
        {"aut-old"},
        not_before=created_at,
        deadline=voice.time.monotonic() + 1,
        label="test",
    ) == (driver, aut)


def test_fresh_pair_rejects_ambiguous_owner_records(monkeypatch):
    monkeypatch.setattr(voice, "POLL_EVERY_S", 0)
    created_at = datetime.now(timezone.utc)

    with pytest.raises(AssertionError, match="duplicate driver"):
        voice._wait_for_fresh_call_pair(
            lambda: [_call("driver-a", created_at), _call("driver-b", created_at)],
            lambda: [_call("aut-a", created_at)],
            set(),
            set(),
            not_before=created_at,
            deadline=voice.time.monotonic() + 1,
            label="test",
        )


def test_fresh_pair_ignores_old_records_that_arrive_after_snapshot(monkeypatch):
    monkeypatch.setattr(voice, "POLL_EVERY_S", 0)
    request_time = datetime.now(timezone.utc)
    old_driver = _call("late-old-driver", request_time - timedelta(minutes=5))
    current_driver = _call("current-driver", request_time + timedelta(seconds=1))
    current_aut = _call("current-aut", request_time + timedelta(seconds=1))

    assert voice._wait_for_fresh_call_pair(
        lambda: [old_driver, current_driver],
        lambda: [current_aut],
        set(),
        set(),
        not_before=request_time,
        deadline=voice.time.monotonic() + 1,
        label="test",
    ) == (current_driver, current_aut)


def test_cleanup_ends_every_call_created_after_snapshot():
    calls = _Calls()
    client = SimpleNamespace(calls=calls)

    voice._hangup_fresh_calls(
        client,
        lambda: [SimpleNamespace(id="old"), SimpleNamespace(id="new-a"), SimpleNamespace(id="new-b")],
        {"old"},
    )

    assert calls.hung_up == ["new-a", "new-b"]


def test_pretest_sweep_ends_matching_calls():
    calls = _Calls()
    calls.get = lambda call_id: SimpleNamespace(id=call_id, status="completed")
    client = SimpleNamespace(calls=calls)

    voice._sweep_matching_calls(
        client,
        lambda: [
            SimpleNamespace(id="old-a", status="answered"),
            SimpleNamespace(id="old-b", status="ringing"),
        ],
    )

    assert calls.hung_up == ["old-a", "old-b"]


def test_inbound_voice_sweeps_both_call_owners_before_placement():
    lines = inspect.getsource(voice.test_inbound_call_inkbox_tts_stt)

    assert lines.index("_sweep_matching_calls(remote, _driver_outbound)") < lines.index(
        "call = remote.calls.place("
    )
    assert lines.index("_sweep_matching_calls(aut, _aut_inbound)") < lines.index(
        "call = remote.calls.place("
    )


def _call_with(*items):
    return SimpleNamespace(post_call_action_items=list(items))


def test_open_post_call_action_matches_marker_and_sms_intent_across_shapes():
    call = _call_with(
        {
            "status": "open",
            "action": "Send an SMS after the call",
            "details": "Use OpenClaw X-Ray Bravo exactly.",
        },
        SimpleNamespace(
            status=SimpleNamespace(value="open"),
            action="Send a text message",
            details="Content: openclaw xray bravo",
        ),
    )

    matches = voice._matching_open_post_call_actions(
        call, "openclaw x ray bravo"
    )

    assert len(matches) == 2


def test_open_post_call_action_rejects_closed_wrong_marker_and_non_sms_items():
    call = _call_with(
        {
            "status": "completed",
            "action": "Send an SMS",
            "details": "openclaw xray bravo",
        },
        {
            "status": "open",
            "action": "Send an SMS",
            "details": "openclaw wrong marker",
        },
        {
            "status": "open",
            "action": "Remember this note",
            "details": "openclaw xray bravo",
        },
    )

    assert voice._matching_open_post_call_actions(
        call, "openclaw x ray bravo"
    ) == []


def test_direct_contact_read_log_matching_accepts_both_formats_and_exact_call():
    call_id = "7dc75142-b136-48df-a3c3-734925e73dbf"
    console = (
        "2026-08-01T08:43:19Z [inkbox] realtime direct contact read "
        f"inkbox_list_contacts for call_id={call_id}"
    )
    structured = (
        '"message":"Inkbox realtime direct contact read inkbox_get_contact '
        f'for call_id={call_id}"'
    )

    assert voice._gateway_has_direct_contact_read(console, call_id)
    assert voice._gateway_has_direct_contact_read(structured, call_id.upper())
    assert not voice._gateway_has_direct_contact_read(console, "wrong-call-id")
    assert not voice._gateway_has_direct_contact_read(
        f"[inkbox] realtime contact lookup call_id={call_id}", call_id
    )


def test_hosted_marker_normalizes_asr_separators_without_unsafe_prefix():
    marker = "victor delta delta november papa"
    asr_variant = "Victor, delta-delta / november... papa"
    call = _call_with(
        {
            "status": "open",
            "action": "Send an SMS",
            "details": f"Use this marker: {asr_variant}",
        },
    )

    assert voice._voice_marker_key(marker) == voice._voice_marker_key(asr_variant)
    assert len(voice._matching_open_post_call_actions(call, marker)) == 1
    assert "openclaw" not in marker


def test_post_call_action_diagnostics_are_content_free_and_redacted():
    sentinel_name = "PRIVATE-NAME-SENTINEL"
    sentinel_body = "PRIVATE-BODY-SENTINEL"
    call = _call_with(
        {
            "status": "OPEN",
            "action": f"Send an SMS to {sentinel_name}",
            "details": f"Exact body: apple basket {sentinel_body}",
        },
    )

    diagnostic = voice._post_call_action_diagnostics(
        call,
        "apple basket candle dragon engine",
    )[0]

    assert diagnostic == {
        "open": True,
        "sms_intent": True,
        "marker_words_present": 2,
        "marker_words_expected": 5,
        "action_length": len(f"Send an SMS to {sentinel_name}"),
        "details_length": len(f"Exact body: apple basket {sentinel_body}"),
    }
    assert sentinel_name not in repr(diagnostic)
    assert sentinel_body not in repr(diagnostic)


def test_live_voice_marker_is_deterministic_distinct_and_speech_safe():
    observed = set()
    for value in range(1_000):
        token = f"run-{value}-attempt-{value % 7}"
        marker = voice_marker.marker_from_token(token).split()

        assert marker == voice_marker.marker_from_token(token).split()
        assert len(marker) == 3
        assert len(set(marker)) == len(marker)
        assert set(marker) <= set(voice_marker.SPEECH_WORDS)
        observed.add(tuple(marker))

    assert len(observed) > 900


def test_live_voice_marker_mapping_is_stable():
    assert voice_marker.marker_from_token("55071").split() == [
        "pineapple",
        "sandwich",
        "kangaroo",
    ]


def test_live_workflow_uses_canonical_hosted_action_stimulus_and_test_owned_hangup():
    workflow = (
        Path(__file__).parents[2] / ".github" / "workflows" / "live-voice.yml"
    ).read_text(encoding="utf-8")

    assert 'HOSTED_MARKER="openclaw"' not in workflow
    assert "RADIO_WORDS" not in workflow
    assert 'RUN_TOKEN="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' in workflow
    assert (
        'HOSTED_MARKER="$(python3 '
        '"$GITHUB_WORKSPACE/tests/live/voice_marker.py" "$RUN_TOKEN")"'
    ) in workflow
    assert (
        'export VOICE_DRIVER_LINE="After we hang up, send me one SMS containing '
        'exactly these three words: $HOSTED_MARKER. Create one post-call action now. '
        'Set both the action title and the action details to this exact five-word '
        'phrase: Send SMS $HOSTED_MARKER. Wait for the action tool to succeed, then '
        'read the exact three-word SMS body back to me. Do not paraphrase, omit a '
        'word, or send the SMS during the call."'
    ) in workflow
    assert "send me one SMS containing exactly these words" not in workflow
    assert "export VOICE_DRIVER_LISTEN=180" in workflow
    assert "export VOICE_DRIVER_ANSWER_SETTLE=4" in workflow


def test_every_call_capable_live_ci_gateway_disables_voicemail_detection():
    workflow_dir = Path(__file__).parents[2] / ".github" / "workflows"
    configured = []
    for path in sorted(workflow_dir.glob("*.yml")):
        workflow = path.read_text(encoding="utf-8")
        if "channels.inkbox.apiKey" not in workflow:
            continue
        configured.append(path.name)
        assert "channels.inkbox.voicemailDetection disabled" in workflow, (
            f"{path.name} configures a call-capable Inkbox gateway without "
            "explicitly disabling voicemail detection"
        )

    assert configured == [
        "live-a2a.yml",
        "live-channels.yml",
        "live-external-events.yml",
        "live-voice.yml",
    ]
