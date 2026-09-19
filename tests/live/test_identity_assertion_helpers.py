"""Real-model assertions must prove every requested identity field."""

from types import SimpleNamespace

import pytest

import test_email_intelligence as email
import test_sms as sms


@pytest.mark.parametrize("body, expected", [
    ("+1 (555) 000-1234", True),
    ("15550001234", True),
    ("ending in 1234", False),
    ("+1 *** *** 1234", False),
    ("5550001234", False),
    ("915550001234", False),
    ("155500012345", False),
])
def test_phone_requires_full_number_not_mask_or_suffix(body, expected):
    assert email._phone_present("+15550001234", body) is expected


def test_sms_identity_rejects_email_only(monkeypatch):
    aut = SimpleNamespace(mailboxes=SimpleNamespace(list=lambda: [
        SimpleNamespace(email_address="identity@example.com"),
    ]))
    monkeypatch.setattr(sms, "_ask_sms", lambda *_args: "identity@example.com")
    with pytest.raises(AssertionError, match="full expected phone"):
        sms.test_sms_reports_own_identity({"aut": aut, "aut_phone": "+15550001234"})


def test_sms_sender_fixture_cannot_silently_skip():
    aut = SimpleNamespace(contacts=SimpleNamespace(lookup=lambda **_kwargs: []))
    remote = SimpleNamespace(mailboxes=SimpleNamespace(list=lambda: [
        SimpleNamespace(email_address="caller@example.com"),
    ]))
    with pytest.raises(AssertionError, match="fixture is missing"):
        sms.test_sms_reports_sender_details({"aut": aut, "remote": remote})


def test_email_identity_requires_requested_display_name(monkeypatch):
    aut = SimpleNamespace(
        mailboxes=SimpleNamespace(list=lambda: [SimpleNamespace(email_address="identity@example.com")]),
        phone_numbers=SimpleNamespace(list=lambda: [SimpleNamespace(number="+15550001234")]),
        get_identity=lambda _handle: SimpleNamespace(display_name="Actual Display Name"),
    )
    monkeypatch.setattr(email, "_ask", lambda *_args, **_kwargs: "identity@example.com +15550001234")
    with pytest.raises(AssertionError, match="display name"):
        email.test_reports_own_identity({
            "aut": aut, "remote": None, "aut_email": "identity@example.com",
            "remote_email": "caller@example.com",
        })


def test_sms_acknowledgement_cannot_be_an_arbitrary_error(monkeypatch):
    monkeypatch.setattr(sms, "_ask_sms", lambda *_args: "An error occurred. Please try again.")
    with pytest.raises(AssertionError, match="confirm OK"):
        sms.test_sms_basic_reply({})


def test_delivery_failure_injection_uses_authoritative_tunnel(monkeypatch):
    aut = SimpleNamespace(
        mailboxes=SimpleNamespace(list=lambda: [SimpleNamespace(email_address="identity@example.com")]),
        get_identity=lambda _handle: SimpleNamespace(tunnel=SimpleNamespace(public_host="synthetic.example.com")),
    )
    requests = []

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    def post(request, **_kwargs):
        requests.append(request)
        return Response()

    monkeypatch.setattr(sms, "AUT_WEBHOOK_URL", "")
    monkeypatch.setattr(sms, "SIGNING_KEY", "synthetic-signing-key")
    monkeypatch.setattr(sms.urllib.request, "urlopen", post)
    assert sms._inject_inkbox_webhook({"event_type": "text.delivery_failed"}, aut) == 200
    assert requests[0].full_url == "https://synthetic.example.com/"
    assert requests[0].get_header("X-inkbox-signature").startswith("sha256=")
