"""Resolve the existing, owned live SMS ingress; never create or reconnect it."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def ready_default_account(health):
    channel = health.get("channels", {}).get("inkbox", {})
    accounts = channel.get("accounts")
    if isinstance(accounts, dict):
        assert set(accounts) == {"default"}, "expected one configured default Inkbox account"
        account = accounts["default"]
    else:
        account = channel
    assert account.get("accountId") == "default", "missing default Inkbox account"
    assert account.get("configured") is True, "Inkbox account is not configured"
    assert account.get("running") is True and account.get("connected") is True, "Inkbox gateway is not connected"
    assert account.get("mode") == "inkbox-tunnel", "carrier CI requires the existing tunnel ingress"
    return account


def resolve_owned_ingress(client, handle, health, *, legacy_status=False):
    """Use only public SDK reads and the exact configured native account."""
    assert isinstance(handle, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]*", handle), "invalid configured identity"
    account = ready_default_account(health)
    # The supported May host omits identity from its native status projection.
    # The exact config leaf and authenticated SDK ownership remain mandatory.
    if "identity" in account:
        assert account["identity"] == handle, "running native account does not match the configured identity"
    else:
        assert legacy_status, "current native status is missing its identity"
    auth = client.whoami()
    assert auth.auth_type == "api_key" and auth.organization_id, "missing authenticated organization"
    matches = [identity for identity in client.list_identities() if identity.agent_handle == handle]
    assert len(matches) == 1, "configured identity is missing or ambiguous"
    summary = matches[0]
    assert summary.organization_id == auth.organization_id, "configured identity belongs to another organization"
    identity = client.get_identity(handle)
    assert identity.agent_handle == handle and identity.id == summary.id, "configured identity changed"
    scope = getattr(auth, "scope", None)
    if auth.auth_subtype != "api_key.admin_scoped":
        assert scope == f"agent_identity:{identity.id}", "credential does not own the configured identity"
    tunnel_ref = identity.tunnel
    assert tunnel_ref and tunnel_ref.agent_identity_id == identity.id, "identity has no owned tunnel"
    tunnel = client.tunnels.get(tunnel_ref.id)
    assert tunnel.id == tunnel_ref.id and tunnel.agent_identity_id == identity.id, "tunnel ownership changed"
    assert tunnel.organization_id == auth.organization_id, "tunnel belongs to another organization"
    assert tunnel.status == "active" and tunnel.currently_connected is True, "owned tunnel is not active and connected"
    host = tunnel.public_host
    assert host == tunnel_ref.public_host, "tunnel routing metadata changed"
    assert isinstance(host, str) and re.fullmatch(
        r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", host
    ), "invalid owned tunnel hostname"
    # This is the existing default-account route, not an inferred tunnel name.
    return f"https://{host}/inkbox/webhook"


def native_output(args):
    result = subprocess.run(["openclaw", *args], capture_output=True, text=True, timeout=25, check=True)
    return result.stdout


def native_json(args):
    return json.loads(native_output(args))


def main():
    try:
        assert os.environ.get("AUT_INKBOX_SIGNING_KEY"), "carrier CI requires its signing key"
        assert os.environ.get("OPENCLAW_INKBOX_API_KEY"), "carrier CI requires its configured credential"
        # Read only the identity leaf; never retrieve the credential-bearing config.
        handle = native_json(["config", "get", "channels.inkbox.identity", "--json"])
        health = native_json(["health", "--json"])
        version = re.fullmatch(r"OpenClaw (\d{4}\.\d{1,2}\.\d{1,2})(?: \([0-9a-f]+\))?", native_output(["--version"]).strip())
        assert version, "native host version is unavailable"
        from inkbox import Inkbox
        with Inkbox(api_key=os.environ["OPENCLAW_INKBOX_API_KEY"],
                    base_url=os.environ.get("INKBOX_BASE_URL", "https://inkbox.ai"), timeout=10) as client:
            url = resolve_owned_ingress(client, handle, health, legacy_status=version.group(1) == "2026.5.27")
        # GitHub prints step environment variables. Keep the identity-bearing
        # URL in a private file and export only its path, never the host itself.
        with tempfile.NamedTemporaryFile(mode="w", prefix="inkbox-carrier-ingress-",
                                         dir=os.environ["RUNNER_TEMP"], delete=False) as route:
            route.write(url + "\n")
            route_path = route.name
        with Path(os.environ["GITHUB_ENV"]).open("a") as target:
            target.write(f"AUT_WEBHOOK_URL_FILE={route_path}\nINKBOX_REQUIRE_CARRIER_INGRESS=1\n")
        print("Owned, connected carrier-test ingress verified.")
        return 0
    except Exception:
        # SDK/native exceptions may contain private identity URLs or credentials.
        print("Carrier-test ingress preflight failed; no event was sent.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
