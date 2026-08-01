"""Focused contract tests for hosted-voice live-proof normalization."""

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
