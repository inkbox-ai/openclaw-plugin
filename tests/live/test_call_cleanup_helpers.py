"""Focused contracts for live-call cleanup ownership."""

from types import SimpleNamespace

import conftest as live_conftest


def test_cleanup_targets_only_explicit_and_session_created_calls():
    assert live_conftest._cleanup_targets(
        baseline={"old-active", "old-ended"},
        current={"old-active", "new-expected", "new-unexpected"},
        explicitly_owned={"new-expected"},
    ) == {"new-expected", "new-unexpected"}


def test_finish_calls_ignores_unowned_active_calls(monkeypatch):
    calls = {
        "owned": SimpleNamespace(id="owned", status="active"),
        "other": SimpleNamespace(id="other", status="active"),
    }
    client = SimpleNamespace()
    hung_up = []

    def owned_calls(_client, _local_phone):
        return calls

    def hangup(_client, call):
        hung_up.append(str(call.id))
        calls[str(call.id)].status = "completed"
        return None

    monkeypatch.setattr(live_conftest, "_owned_calls", owned_calls)
    monkeypatch.setattr(live_conftest, "_hang_up_owned_call", hangup)

    live_conftest._finish_calls(client, "+15551234567", {"owned"})

    assert hung_up == ["owned"]
    assert calls["other"].status == "active"
