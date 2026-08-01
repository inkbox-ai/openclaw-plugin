"""Focused contract tests for hosted-voice live-proof normalization."""

from pathlib import Path
from types import SimpleNamespace

import test_voice as voice


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


def test_post_call_action_diagnostics_are_normalized_bounded_and_redacted():
    call = _call_with(
        {
            "status": "OPEN",
            "action": "Send an SMS to +1 (555) 123-4567!!!",
            "details": "Email person@example.com; " + "word " * 80,
        },
    )

    diagnostic = voice._post_call_action_diagnostics(call)[0]

    assert diagnostic["status"] == "open"
    assert diagnostic["action"] == "send an sms to phone"
    assert diagnostic["details"].startswith("email email word")
    assert len(diagnostic["details"]) <= 160
    assert "555" not in repr(diagnostic)
    assert "example.com" not in repr(diagnostic)


def test_live_workflow_uses_nato_only_marker_and_test_owned_hangup():
    workflow = (
        Path(__file__).parents[2] / ".github" / "workflows" / "live-voice.yml"
    ).read_text(encoding="utf-8")

    assert 'HOSTED_MARKER=""' in workflow
    assert 'HOSTED_MARKER="openclaw"' not in workflow
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
