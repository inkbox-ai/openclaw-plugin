"""Live provider/session coverage for an Inkbox-signed external event.

Real calls remain covered by test_voice.py. This test proves authenticated
external data crosses the webhook boundary and reaches the OpenClaw session
dispatcher without depending on a model obeying arbitrary webhook prose.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.request
import uuid

import pytest

SIGNING_KEY = os.environ.get("OPENCLAW_INKBOX_SIGNING_KEY")
WEBHOOK_URL = os.environ.get("AUT_WEBHOOK_URL", "http://127.0.0.1:18789/inkbox/webhook")
GATEWAY_LOG = os.environ.get("GATEWAY_LOG", "")
TIMEOUT_S = float(os.environ.get("LIVE_EXTERNAL_TIMEOUT", "45"))
POLL_EVERY_S = 0.5

pytestmark = pytest.mark.skipif(
    not (SIGNING_KEY and GATEWAY_LOG and os.environ.get("LIVE_REAL_MODEL") == "1"),
    reason="external-event suite needs signing key + gateway log + LIVE_REAL_MODEL=1",
)


def _sign(payload: bytes, request_id: str, timestamp: str) -> str:
    key = SIGNING_KEY.removeprefix("whsec_")
    message = f"{request_id}.{timestamp}.".encode() + payload
    return "sha256=" + hmac.new(key.encode(), message, hashlib.sha256).hexdigest()


def _post(envelope: dict) -> tuple[int, str]:
    payload = json.dumps(envelope).encode()
    request_id = str(uuid.uuid4())
    timestamp = str(int(time.time()))
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Inkbox-Request-Id": request_id,
            "X-Inkbox-Timestamp": timestamp,
            "X-Inkbox-Signature": _sign(payload, request_id, timestamp),
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 -- local gateway
        return resp.status, resp.read().decode()


def _log() -> str:
    try:
        with open(GATEWAY_LOG, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return ""


def _wait(marker: str) -> bool:
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
        if marker in _log():
            return True
        time.sleep(POLL_EVERY_S)
    return False


def test_signed_external_event_reaches_openclaw_dispatcher():
    event_id = str(uuid.uuid4().int % 10**17)
    envelope = {
        "id": event_id,
        "source": "live-e2e",
        "event": "deployment_completed",
        "title": "Live external-event delivery probe",
        "summary": "The synthetic deployment completed successfully.",
    }
    marker = f"Inkbox external event dispatched: thread=external:live-e2e:{event_id} verified=true"
    status, body = _post(envelope)
    assert status == 200 and body == "ok", f"webhook not accepted: status={status}"
    assert _wait(marker), f"signed event never reached OpenClaw: {marker}"
