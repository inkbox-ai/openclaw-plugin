"""Failure diagnostics must distinguish mailbox stages without leaking content."""

from types import SimpleNamespace

from inkbox.mail.types import MessageDirection

from test_email_intelligence import _email_failure_shape


def test_email_failure_shape_correlates_current_request_and_redacts_content(tmp_path):
    current = "private-current-nonce"
    inbound = SimpleNamespace(subject=current, status="received", is_read=True)
    outbound = SimpleNamespace(subject=current, status="private-provider-error", is_read=False)
    unrelated = SimpleNamespace(subject="private-old-subject", status="sent", is_read=True)
    calls = []

    def rows(address, *, direction, page_size):
        calls.append((direction, page_size))
        return iter([inbound if direction == MessageDirection.INBOUND else outbound, unrelated])

    log = tmp_path / "gateway.log"
    old = b"[inkbox] source reply shape: mode=email kind=final chars=999 error=false status=false silent=false\n"
    log.write_bytes(old + b"PRIVATE MESSAGE BODY\n[inkbox] source reply shape: mode=email kind=final chars=12 error=false status=false silent=false\n")
    result = _email_failure_shape(SimpleNamespace(messages=SimpleNamespace(list=rows)),
                                  "private-address", current, log, len(old))

    assert "aut_inbound_matches=1" in result
    assert "aut_inbound_read=1" in result
    assert "aut_inbound_statuses={'received': 1}" in result
    assert "aut_outbound_matches=1" in result
    assert "aut_outbound_statuses={'other': 1}" in result
    assert "chars=12" in result
    assert "chars=999" not in result
    assert "private" not in result.lower()
    assert "MESSAGE BODY" not in result
    assert calls == [(MessageDirection.INBOUND, 100), (MessageDirection.OUTBOUND, 100)]


def test_email_failure_shape_bounds_inventory_and_does_not_fetch_bodies():
    def rows(*args, **kwargs):
        for _ in range(100):
            yield SimpleNamespace(subject="old", status="sent", is_read=False)
        raise AssertionError("diagnostic must not paginate past its bound")

    result = _email_failure_shape(SimpleNamespace(messages=SimpleNamespace(list=rows)),
                                  "private-address", "current", None, 0)

    assert "aut_inbound_matches=0 aut_inbound_scan_capped=True" in result
    assert "aut_outbound_matches=0 aut_outbound_scan_capped=True" in result
    assert "gateway_window=unavailable" in result


def test_email_failure_shape_cannot_expose_read_errors_or_replace_original_failure(tmp_path):
    def fail(*args, **kwargs):
        raise RuntimeError("private credential and endpoint")

    result = _email_failure_shape(SimpleNamespace(messages=SimpleNamespace(list=fail)),
                                  "private-address", "private-nonce", tmp_path / "missing", 0)

    assert result == ("aut_inbound_read_failed=true aut_outbound_read_failed=true "
                      "gateway_window=unavailable")
