"""Focused checks for the deterministic progress-model contract."""

import mock_openai


def test_progress_task_waits_but_side_writer_returns_immediately(monkeypatch):
    monkeypatch.setenv("MOCK_A2A_SCENARIO", "inbound-progress")
    token = "a2a-ci-inbound-progress-123456abcdef"
    main = {
        "stream": True,
        "messages": [{"role": "user", "content": f"Wait twice. {token}"}],
    }
    side = {
        "stream": True,
        "messages": [{
            "role": "user",
            "content": (
                "[inkbox:a2a_progress elapsed_seconds=60] "
                f"Task context: {token}"
            ),
        }],
    }

    assert mock_openai._is_streaming_progress_task(main)
    assert not mock_openai._is_streaming_progress_task(side)
    assert mock_openai._reply_text(side) == (
        "I'm working through the requested calculation. (60s elapsed)"
    )


def test_progress_task_returns_exact_result_and_token(monkeypatch):
    monkeypatch.setenv("MOCK_A2A_SCENARIO", "inbound-progress")
    token = "a2a-ci-inbound-progress-123456abcdef"
    request = {
        "stream": True,
        "messages": [{"role": "user", "content": token}],
    }

    result = mock_openai._progress_final_text(request)

    assert "4 + 6 = 10" in result
    assert token in result


def test_progress_writer_uses_latest_elapsed_marker():
    request = {
        "messages": [{
            "role": "user",
            "content": (
                "Earlier: [inkbox:a2a_progress elapsed_seconds=60]. "
                "Current: [inkbox:a2a_progress elapsed_seconds=121]."
            ),
        }],
    }

    assert mock_openai._reply_text(request).endswith("(121s elapsed)")
