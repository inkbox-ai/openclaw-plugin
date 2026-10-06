"""Offline contracts for the real carrier task's owned tunnel discovery."""
import copy
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from types import SimpleNamespace

import httpx
import pytest

import sms_ingress


IDENTITY = "00000000-0000-4000-8000-000000000001"
TUNNEL = "00000000-0000-4000-8000-000000000002"
FOREIGN = "00000000-0000-4000-8000-000000000003"
HEALTH = {"channels": {"inkbox": {"accounts": {"default": {
    "accountId": "default", "configured": True, "running": True,
    "connected": True, "mode": "inkbox-tunnel", "identity": "configured-agent",
}}}}}


def sdk_client(monkeypatch, mutate=lambda _responses: None):
    from inkbox import Inkbox
    tunnel = {
        "id": TUNNEL, "organization_id": "test-org", "agent_identity_id": IDENTITY,
        "tunnel_name": "not-the-public-host", "tls_mode": "edge", "status": "active",
        "currently_connected": True, "public_host": "authoritative.example.test", "zone": "example.test",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
    }
    identity = {
        "id": IDENTITY, "organization_id": "test-org", "agent_handle": "configured-agent",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z", "tunnel": copy.deepcopy(tunnel),
    }
    responses = {
        "/api/whoami": {"auth_type": "api_key", "auth_subtype": "api_key.agent_scoped.claimed",
                        "organization_id": "test-org", "scope": f"agent_identity:{IDENTITY}"},
        "/api/v1/identities/": [copy.deepcopy(identity)],
        "/api/v1/identities/configured-agent": identity,
        f"/api/v1/tunnels/{TUNNEL}": tunnel,
    }
    mutate(responses)
    requests = []
    def handle(request):
        requests.append((request.method, request.url.path))
        assert request.method == "GET", "discovery must not reconnect, provision, or send"
        assert request.url.path in responses
        return httpx.Response(200, json=responses[request.url.path])
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **_kwargs: httpx.MockTransport(handle))
    return Inkbox(api_key="synthetic-only", base_url="https://example.invalid", timeout=10), requests


def test_published_sdk_reads_exact_identity_owned_connected_tunnel(monkeypatch):
    client, requests = sdk_client(monkeypatch)
    with client:
        assert sms_ingress.resolve_owned_ingress(client, "configured-agent", HEALTH) == "https://authoritative.example.test/inkbox/webhook"
    assert requests == [("GET", path) for path in (
        "/api/whoami", "/api/v1/identities/", "/api/v1/identities/configured-agent", f"/api/v1/tunnels/{TUNNEL}",
    )]


@pytest.mark.parametrize("case", [
    "missing-identity", "duplicate-identity", "foreign-identity-org", "foreign-scope", "identity-changed",
    "missing-tunnel", "foreign-summary-owner", "foreign-tunnel-id", "foreign-owner", "foreign-org",
    "disconnected", "unknown-connection", "inactive", "changed-host", "invalid-host", "missing-host",
])
def test_owned_ingress_rejects_missing_ambiguous_foreign_and_disconnected_metadata(monkeypatch, case):
    def mutate(r):
        identities = r["/api/v1/identities/"]
        identity = r["/api/v1/identities/configured-agent"]
        tunnel = r[f"/api/v1/tunnels/{TUNNEL}"]
        if case == "missing-identity": identities.clear()
        elif case == "duplicate-identity": identities.append(copy.deepcopy(identities[0]))
        elif case == "foreign-identity-org": identities[0]["organization_id"] = "foreign"
        elif case == "foreign-scope": r["/api/whoami"]["scope"] = f"agent_identity:{FOREIGN}"
        elif case == "identity-changed": identity["id"] = FOREIGN
        elif case == "missing-tunnel": identity["tunnel"] = None
        elif case == "foreign-summary-owner": identity["tunnel"]["agent_identity_id"] = FOREIGN
        elif case == "foreign-tunnel-id": tunnel["id"] = FOREIGN
        elif case == "foreign-owner": tunnel["agent_identity_id"] = FOREIGN
        elif case == "foreign-org": tunnel["organization_id"] = "foreign"
        elif case == "disconnected": tunnel["currently_connected"] = False
        elif case == "unknown-connection": tunnel.pop("currently_connected")
        elif case == "inactive": tunnel["status"] = "deleted"
        elif case == "changed-host": tunnel["public_host"] = "changed.example.test"
        elif case in {"invalid-host", "missing-host"}:
            tunnel["public_host"] = identity["tunnel"]["public_host"] = "user@foreign.example.test" if case == "invalid-host" else ""
    client, _requests = sdk_client(monkeypatch, mutate)
    with client, pytest.raises((AssertionError, ValueError)):
        sms_ingress.resolve_owned_ingress(client, "configured-agent", HEALTH)


@pytest.mark.parametrize("change", ["missing", "multiple", "wrong-account", "not-configured", "stopped", "disconnected", "public-url"])
def test_native_readiness_is_exact_default_account_not_any_connected_account(change):
    health = copy.deepcopy(HEALTH)
    accounts = health["channels"]["inkbox"]["accounts"]
    if change == "missing": accounts.clear()
    elif change == "multiple": accounts["other"] = copy.deepcopy(accounts["default"])
    else:
        key, value = {"wrong-account": ("accountId", "other"), "not-configured": ("configured", False),
                      "stopped": ("running", False), "disconnected": ("connected", False), "public-url": ("mode", "public-url")}[change]
        accounts["default"][key] = value
    with pytest.raises(AssertionError):
        sms_ingress.ready_default_account(health)


def test_preflight_reads_only_native_identity_leaf_and_exports_without_logging_private_metadata(monkeypatch, tmp_path, capsys):
    import inkbox
    client, _requests = sdk_client(monkeypatch)
    monkeypatch.setattr(inkbox, "Inkbox", lambda **_kwargs: client)
    native_calls = []
    def run(argv, **kwargs):
        native_calls.append(argv)
        assert kwargs == {"capture_output": True, "text": True, "timeout": 25, "check": True}
        return SimpleNamespace(stdout="OpenClaw 2026.9.8 (abc123)" if argv[1] == "--version" else json.dumps("configured-agent" if argv[1] == "config" else HEALTH))
    monkeypatch.setattr(sms_ingress.subprocess, "run", run)
    monkeypatch.setenv("AUT_INKBOX_SIGNING_KEY", "synthetic-signing")
    monkeypatch.setenv("OPENCLAW_INKBOX_API_KEY", "synthetic-only")
    path = tmp_path / "env"
    monkeypatch.setenv("GITHUB_ENV", str(path))
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    assert sms_ingress.main() == 0
    assert native_calls == [["openclaw", "config", "get", "channels.inkbox.identity", "--json"], ["openclaw", "health", "--json"], ["openclaw", "--version"]]
    exported = dict(line.split("=", 1) for line in path.read_text().splitlines())
    assert exported["INKBOX_REQUIRE_CARRIER_INGRESS"] == "1"
    assert "authoritative" not in path.read_text()
    route_path = Path(exported["AUT_WEBHOOK_URL_FILE"])
    assert route_path.read_text() == "https://authoritative.example.test/inkbox/webhook\n"
    assert route_path.stat().st_mode & 0o777 == 0o600
    output = capsys.readouterr()
    assert "configured-agent" not in output.out and "authoritative" not in output.out and not output.err


def test_missing_signing_key_fails_preflight_without_sdk_or_native_reads(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("AUT_INKBOX_SIGNING_KEY", raising=False)
    path = tmp_path / "env"
    monkeypatch.setenv("GITHUB_ENV", str(path))
    monkeypatch.setattr(sms_ingress, "native_json", lambda _args: pytest.fail("must reject before reads"))
    assert sms_ingress.main() == 1
    assert not path.exists()
    assert "no event was sent" in capsys.readouterr().err


def test_foreign_native_owner_fails_before_sdk_reads():
    health = copy.deepcopy(HEALTH)
    health["channels"]["inkbox"]["accounts"]["default"]["identity"] = "foreign-agent"
    with pytest.raises(AssertionError, match="running native account"):
        sms_ingress.resolve_owned_ingress(object(), "configured-agent", health)


def test_minimum_native_status_omits_identity_but_still_requires_exact_sdk_ownership(monkeypatch):
    health = copy.deepcopy(HEALTH)
    health["channels"]["inkbox"]["accounts"]["default"].pop("identity")
    client, _requests = sdk_client(monkeypatch)
    with client:
        with pytest.raises(AssertionError, match="missing its identity"):
            sms_ingress.resolve_owned_ingress(client, "configured-agent", health)
        assert sms_ingress.resolve_owned_ingress(client, "configured-agent", health, legacy_status=True) == "https://authoritative.example.test/inkbox/webhook"
    def foreign(r):
        r[f"/api/v1/tunnels/{TUNNEL}"]["agent_identity_id"] = FOREIGN
    client, _requests = sdk_client(monkeypatch, foreign)
    with client, pytest.raises(AssertionError, match="tunnel ownership"):
        sms_ingress.resolve_owned_ingress(client, "configured-agent", health, legacy_status=True)


def test_native_or_sdk_failure_keeps_private_exception_out_of_output_and_exports_nothing(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("AUT_INKBOX_SIGNING_KEY", "synthetic-signing")
    monkeypatch.setenv("OPENCLAW_INKBOX_API_KEY", "synthetic-only")
    path = tmp_path / "env"
    monkeypatch.setenv("GITHUB_ENV", str(path))
    def fail(_args):
        raise RuntimeError("private-host-and-credential")
    monkeypatch.setattr(sms_ingress, "native_json", fail)
    assert sms_ingress.main() == 1
    assert not path.exists()
    output = capsys.readouterr()
    assert "private-host-and-credential" not in output.err + output.out


@pytest.mark.parametrize("status", [200, 302, 404])
def test_signed_event_body_is_unchanged_and_redirects_never_receive_it(monkeypatch, status):
    import test_sms
    received = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, dict(self.headers), self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(status)
            if status == 302:
                self.send_header("Location", "/foreign")
            self.end_headers()
        def do_GET(self):
            received.append((self.path, {}, b""))
            self.send_response(200)
            self.end_headers()
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setattr(test_sms, "AUT_WEBHOOK_URL", f"http://127.0.0.1:{server.server_port}/owned")
        monkeypatch.setattr(test_sms, "SIGNING_KEY", "whsec_synthetic-signing")
        envelope = {"id": "synthetic-event", "event_type": "text.delivery_failed", "data": {"text_message": {"error_code": "40002"}}}
        assert test_sms._inject_inkbox_webhook(envelope) == status
        assert len(received) == 1 and received[0][0] == "/owned"
        _path, headers, body = received[0]
        assert body == json.dumps(envelope).encode()
        material = f"{headers['X-Inkbox-Request-Id']}.{headers['X-Inkbox-Timestamp']}.".encode() + body
        assert headers["X-Inkbox-Signature"] == "sha256=" + hmac.new(b"synthetic-signing", material, hashlib.sha256).hexdigest()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
