"""Focused contract tests for hosted-voice live-proof normalization."""

import time
from datetime import datetime, timezone

from pathlib import Path
from types import SimpleNamespace

import test_voice as voice
import voice_marker


def test_voice_driver_allows_realtime_response_latency():
    driver = (Path(__file__).parent / "voice_driver.py").read_text()
    assert 'VOICE_DRIVER_LISTEN", "30"' in driver


def _call_with(*items):
    return SimpleNamespace(post_call_action_items=list(items))


def test_paired_agent_leg_is_queried_through_aut_identity():
    stamp = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    pair_id = "33333333-3333-3333-3333-333333333333"
    driver_call = SimpleNamespace(
        id="driver", paired_call_id=pair_id, created_at=stamp,
    )
    aut_call = SimpleNamespace(
        id="aut", paired_call_id=pair_id, direction="outbound", created_at=stamp,
    )
    driver = SimpleNamespace(calls=SimpleNamespace(get=lambda _call_id: driver_call))

    class Calls:
        kwargs = None

        def list(self, **kwargs):
            self.kwargs = kwargs
            return [aut_call]

    calls = Calls()
    result = voice._wait_for_agent_leg(
        driver,
        SimpleNamespace(calls=calls),
        "driver",
        lambda: [],
        direction="outbound",
        deadline=time.monotonic() + 1,
    )

    assert result is aut_call
    assert calls.kwargs == {"limit": 2, "paired_call_id": pair_id}


def test_owned_leg_transcript_proof_uses_local_speech_correctly():
    class Calls:
        def __init__(self, segments):
            self.segments = segments

        def transcripts(self, _call_id):
            return self.segments

        def get(self, _call_id):
            return SimpleNamespace(status="answered")

    driver = SimpleNamespace(calls=Calls([
        SimpleNamespace(party="local", text="scripted driver line"),
    ]))
    aut = SimpleNamespace(calls=Calls([
        SimpleNamespace(party="remote", text="caller line"),
        SimpleNamespace(party="local", text="agent reply"),
    ]))
    deadline = time.monotonic() + 1

    assert voice._wait_for_driver_local_speech(
        driver, "unused", "driver", deadline=deadline
    ) == "scripted driver line"
    assert voice._wait_for_two_way_call(
        aut, "unused", "aut", deadline=deadline
    ) == "agent reply"


def test_aut_speech_mode_refreshes_the_exact_owned_leg():
    requested = []

    def get(call_id):
        requested.append(call_id)
        return SimpleNamespace(use_inkbox_tts=False, use_inkbox_stt=False)

    assert voice._aut_speech_mode(
        SimpleNamespace(calls=SimpleNamespace(get=get)), "aut-call-id"
    ) == (False, False)
    assert requested == ["aut-call-id"]


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
    for digit in range(10):
        token = str(digit) * 5
        marker = voice_marker.marker_from_token(token).split()

        assert marker == voice_marker.marker_from_token(token).split()
        assert len(marker) == 5
        assert len(set(marker)) == len(marker)
        assert set(marker) <= set(voice_marker.SPEECH_WORDS)


def test_live_voice_marker_mapping_is_stable():
    assert voice_marker.marker_from_token("55071").split() == [
        "umbrella",
        "chocolate",
        "banana",
        "library",
        "elephant",
    ]


def test_live_workflow_uses_canonical_hosted_action_stimulus_and_test_owned_hangup():
    workflow = (
        Path(__file__).parents[2] / ".github" / "workflows" / "live-voice.yml"
    ).read_text(encoding="utf-8")

    assert 'HOSTED_MARKER="openclaw"' not in workflow
    assert "RADIO_WORDS" not in workflow
    assert 'DIGITS="${GITHUB_RUN_ID: -4}${GITHUB_RUN_ATTEMPT: -1}"' in workflow
    assert (
        'HOSTED_MARKER="$(python3 '
        '"$GITHUB_WORKSPACE/tests/live/voice_marker.py" "$DIGITS")"'
    ) in workflow
    assert (
        'export VOICE_DRIVER_LINE="After we hang up, send me exactly one SMS containing '
        'exactly $HOSTED_MARKER. Before we hang up, record one post-call action whose action '
        'title and details are both exactly Send SMS $HOSTED_MARKER. Read the five-word SMS '
        'body back after recording it. Do not send the SMS during the call."'
    ) in workflow
    assert (
        'export VOICE_DRIVER_FOLLOWUP_LINE="Verify the post-call action you just recorded. '
        'If its action title or details are not exactly Send SMS $HOSTED_MARKER, edit that '
        'same action now so both match exactly. Then read back exactly $HOSTED_MARKER."'
    ) in workflow
    assert "list the actions" not in workflow.lower()
    assert "export VOICE_DRIVER_FOLLOWUP_AFTER=45" in workflow
    assert "send me one SMS containing exactly these words" not in workflow
    assert "export VOICE_DRIVER_LISTEN=180" in workflow


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
