"""Focused contracts for live voice ownership and correlation."""

import inspect
import json
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
            details="Content: openclaw x ray bravo",
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


@pytest.mark.parametrize("heard", [
    "hospitalkangaroo chocolate",
    "hospital kangaroo chocolatebar",
    "prehospital kangaroo chocolate",
    "hospital chocolate kangaroo",
])
def test_hosted_marker_rejects_merged_subword_or_reordered_speech(heard):
    marker = "hospital kangaroo chocolate"
    call = _call_with({"status": "open", "action": "Send SMS", "details": heard})
    assert voice._matching_open_post_call_actions(call, marker) == []
    assert voice._hosted_heard_marker_shape([_segment("remote", heard)], marker)["marker"] is False


def test_hosted_marker_does_not_alias_xray_and_x_ray():
    call = _call_with({"status": "open", "action": "Send SMS", "details": "openclaw xray bravo"})
    assert voice._matching_open_post_call_actions(call, "openclaw x ray bravo") == []


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


def test_hosted_failure_diagnostics_hide_identifiers_and_unknown_error_text():
    entry = {
        "state": "failed", "outcome": "correction_missing_attempt", "callId": "private-call",
        "smsAttempts": [{"phase": "initial", "state": "failed", "targetMatches": True,
            "errorKind": "private error body", "toolCallIdHash": "private-hash", "target": "private-recipient"}],
    }
    shape = voice._hosted_settlement_diagnostics(entry, 1)
    assert shape["outcome"] == "correction_missing_attempt"
    assert shape["marker_rows"] == 1
    assert shape["attempts"] == 1
    assert shape["attempt_shapes"] == [{"phase": "initial", "state": "failed", "target_matches": True, "error_kind": "unknown"}]
    assert "private" not in repr(shape)


@pytest.mark.parametrize("case, expected_error", [
    ("valid", None),
    ("extra_prose", "body is not exactly"),
    ("unrelated_duplicate", "2 SMS messages"),
    ("late_duplicate", "2 SMS messages"),
    ("in_call", "before the call ended"),
    ("wrong_recipient", "unexpected recipient"),
    ("missing_created", "no creation timestamp"),
    ("missing_end", "no authoritative end timestamp"),
])
def test_hosted_waiter_requires_exact_body_all_sends_and_post_call_time(
    case, expected_error, monkeypatch, tmp_path,
):
    when = datetime(2026, 9, 19, tzinfo=timezone.utc)
    marker = "hospital kangaroo chocolate"
    phone = "+15550001111"
    message = SimpleNamespace(
        id="new", direction="outbound", remote_phone_number=phone,
        recipients=[], text=marker, created_at=when,
    )
    extra = SimpleNamespace(
        id="extra", direction="outbound", remote_phone_number=phone,
        recipients=[], text="Unrequested confirmation", created_at=when,
    )
    if case == "extra_prose":
        message.text = f"Here are the words: {marker}"
    if case == "wrong_recipient":
        message.remote_phone_number = "+15559999999"
    if case == "in_call":
        message.created_at = when - timedelta(seconds=1)
    if case == "missing_created":
        message.created_at = None
    reads = 0

    def texts(*_args, **_kwargs):
        nonlocal reads
        reads += 1
        return [message, extra] if (
            case == "unrelated_duplicate" or case == "late_duplicate" and reads > 1
        ) else [message]

    aut = SimpleNamespace(
        texts=SimpleNamespace(list=texts),
        calls=SimpleNamespace(get=lambda _id: SimpleNamespace(
            ended_at=None if case == "missing_end" else when,
        )),
    )
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"current": {"callId": "call", "state": "completed"}}))
    monkeypatch.setattr(voice.os.path, "expanduser", lambda _path: str(registry))
    monkeypatch.setattr(voice, "HOSTED_POST_CALL_MARKER", marker)
    now = [0.0]
    monkeypatch.setattr(voice.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(voice.time, "sleep", lambda seconds: now.__setitem__(0, now[0] + seconds))

    def run():
        voice._wait_hosted_sms_settlement(
            aut, "number", phone, set(), when - timedelta(seconds=10), "call", 100, {},
        )

    if expected_error:
        with pytest.raises(AssertionError, match=expected_error) as error:
            run()
        assert marker not in str(error.value)
        assert phone not in str(error.value)
        assert "Unrequested confirmation" not in str(error.value)
    else:
        run()
        assert reads == 2, "successful proof must include the duplicate-grace reread"
        assert now[0] == 2 * voice.POLL_EVERY_S


def test_live_voice_marker_mapping_is_stable():
    assert voice_marker.marker_from_token("55071").split() == [
        "pineapple",
        "sandwich",
        "kangaroo",
    ]


def test_live_workflow_preserves_marker_and_test_owned_hangup():
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
    assert 'HOSTED_SPOKEN_MARKER="${HOSTED_MARKER// /, }"' in workflow
    assert "export VOICE_DRIVER_LISTEN=180" in workflow
    contact_case = workflow.split('elif [ "${{ matrix.scenario }}" = "outbound_realtime_contact" ]; then', 1)[1].split("\n          fi", 1)[0]
    assert "export VOICE_DRIVER_TEST_OWNS_HANGUP=1" in contact_case
    assert "export VOICE_DRIVER_WAIT_FOR_PEER=1" in contact_case


def test_configured_hosted_request_satisfies_persisted_caller_intent_gate(monkeypatch):
    workflow = (
        Path(__file__).parents[2] / ".github" / "workflows" / "live-voice.yml"
    ).read_text(encoding="utf-8")
    statement = next(line.strip() for line in workflow.splitlines()
                     if 'export VOICE_DRIVER_LINE="' in line and "$HOSTED_SPOKEN_MARKER" in line)
    marker = "hospital kangaroo chocolate"
    spoken = statement.split('"', 1)[1].rsplit('"', 1)[0].replace("$HOSTED_SPOKEN_MARKER", marker.replace(" ", ", "))
    assert voice._voice_marker_key(marker) in voice._voice_marker_key(spoken)
    # Callers express outcomes, not the tool/schema solution being evaluated.
    for internal in ("action", "title", "details", "tool", "save", "registry"):
        assert internal not in spoken.lower().split()
    assert "do not text during this call" in spoken.lower()
    assert "one sms" in spoken.lower()
    assert "exactly" in spoken.lower()
    assert "repeat" in spoken.lower()
    remote = SimpleNamespace(calls=_Calls([_segment("local", spoken)]))
    # One ready observation must suffice; otherwise fail without a live wait.
    monkeypatch.setattr(voice.time, "monotonic", lambda: 0)
    monkeypatch.setattr(voice.time, "sleep", lambda _delay: pytest.fail(
        "configured request does not express the recipient, timing, SMS intent and marker"
    ))
    voice._wait_for_hosted_transcript_ready(remote, "unused", "call", marker, 1, {})


@pytest.mark.parametrize("heard_party, passes", [("local", False), ("remote", True)])
def test_hosted_heard_intent_requires_aut_remote_speech(monkeypatch, heard_party, passes):
    marker = "hospital kangaroo chocolate"
    request = f"After we hang up, send me one SMS exactly: {marker}"
    aut = SimpleNamespace(calls=_Calls([_segment(heard_party, request)]))
    ticks = iter([0, 2])
    monkeypatch.setattr(voice.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(voice.time, "sleep", lambda _delay: None)
    if passes:
        voice._wait_for_hosted_transcript_ready(
            aut, "unused", "call", marker, 1, {}, caller_party="remote",
        )
    else:
        with pytest.raises(pytest.fail.Exception, match="caller intent"):
            voice._wait_for_hosted_transcript_ready(
                aut, "unused", "call", marker, 1, {}, caller_party="remote",
            )


@pytest.mark.parametrize("speaker_party", ["local", "remote"])
@pytest.mark.parametrize("segments, passes", [
    ([("remote", "hospital kangaroo chocolate"), ("local", "Hello")], False),
    ([("local", "hospital kangaroo")], False),
    ([("local", "hospital"), ("local", "kangaroo chocolate")], True),
])
def test_hosted_readback_requires_all_words_from_aut_speech(monkeypatch, segments, passes, speaker_party):
    if speaker_party == "remote":
        segments = [("remote" if party == "local" else "local", text) for party, text in segments]
    aut = SimpleNamespace(calls=_Calls([_segment(*row) for row in segments]))
    ticks = iter([0, 2])
    monkeypatch.setattr(voice.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(voice.time, "sleep", lambda _delay: None)
    if passes:
        voice._wait_for_hosted_readback(aut, "call", "hospital kangaroo chocolate", 1, {}, speaker_party=speaker_party)
    else:
        with pytest.raises(pytest.fail.Exception, match="AUT marker readback"):
            voice._wait_for_hosted_readback(aut, "call", "hospital kangaroo chocolate", 1, {}, speaker_party=speaker_party)


def test_hosted_outbound_inventory_keeps_all_pages_and_fixed_window():
    since = datetime(2026, 9, 19, tzinfo=timezone.utc)
    rows = [SimpleNamespace(id=str(index), direction="outbound") for index in range(201)]
    queries = []

    def page(_number, **query):
        queries.append(query)
        return rows[:200] if query["offset"] == 0 else [rows[199], rows[200]]

    aut = SimpleNamespace(texts=SimpleNamespace(list=page))
    assert voice._outbound_texts(aut, "number", since) == rows
    assert queries == [
        {"limit": 200, "offset": offset, "start_datetime": (since - timedelta(minutes=5)).isoformat()}
        for offset in [0, 200]
    ]


def test_hosted_heard_marker_diagnostics_use_aut_remote_speech_without_content():
    marker = "hospital kangaroo chocolate"
    shape = voice._hosted_heard_marker_shape([
        _segment("local", marker),
        _segment("remote", "private phrase kangaroo chocolate"),
    ], marker)
    assert shape == {"caller_segments": 1, "marker": False, "marker_word_positions": [-1, 2, 3]}
    assert "private" not in repr(shape)
    assert voice._hosted_heard_marker_shape([
        _segment("remote", "hospital, kangaroo, chocolate"),
    ], marker) == {"caller_segments": 1, "marker": True, "marker_word_positions": [0, 1, 2]}


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


def test_hd_audio_proof_requires_current_call_and_negotiated_format():
    line = "Inkbox realtime audio negotiated: call_id=current-call format=pcm_s16le_16000"
    assert voice._gateway_has_hd_audio(line, "current-call")
    assert voice._gateway_has_hd_audio(line.upper(), "current-call")
    assert not voice._gateway_has_hd_audio(line, "other-call")
    assert not voice._gateway_has_hd_audio(line.replace("pcm_s16le_16000", "pcmu_8000"), "current-call")
    assert not voice._gateway_has_hd_audio(line.replace("current-call", "current-call-extra"), "current-call")


def test_cleanup_retries_inventory_reads_without_repeating_hangup(monkeypatch):
    calls = _Calls()
    reads = 0
    pauses = []
    monkeypatch.setattr(voice.time, "sleep", pauses.append)

    def inventory():
        nonlocal reads
        reads += 1
        if reads == 1:
            raise TimeoutError("synthetic transport timeout")
        return [SimpleNamespace(id="old"), SimpleNamespace(id="new")]

    voice._hangup_fresh_calls(SimpleNamespace(calls=calls), inventory, {"old"})
    assert reads == 2
    assert pauses == [1]
    assert calls.hung_up == ["new"]


def test_cleanup_read_exhaustion_is_bounded_and_does_not_claim_cleanup(monkeypatch):
    calls = _Calls()
    reads = 0
    monkeypatch.setattr(voice.time, "sleep", lambda _: None)

    def inventory():
        nonlocal reads
        reads += 1
        raise TimeoutError("synthetic private request detail")

    with pytest.raises(RuntimeError, match="after 3 read attempts") as caught:
        voice._hangup_fresh_calls(SimpleNamespace(calls=calls), inventory, set())
    assert "private request detail" not in str(caught.value)
    assert reads == 3
    assert not calls.hung_up
