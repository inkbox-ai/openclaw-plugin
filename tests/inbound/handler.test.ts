import { describe, it, expect, vi, beforeEach } from "vitest";
import { RequestIdDedup } from "../../src/inbound/dedup.js";

// Stub verifyWebhook so we don't have to reverse-engineer the wire signature
// format. The handler delegates HMAC entirely to the SDK; what we're testing
// is everything around that call (headers, dedup, parsing, dispatch wiring).
vi.mock("@inkbox/sdk", () => ({
  verifyWebhook: vi.fn(),
}));

import { verifyWebhook } from "@inkbox/sdk";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";

const baseHeaders = {
  "x-inkbox-request-id": "req-1",
  "x-inkbox-signature": "sig-anything",
  "x-inkbox-timestamp": "1747900800",
};

const mailBody = JSON.stringify({
  event_type: "message.received",
  data: { contacts: [], message: { id: "m-1" } },
});

describe("handleInkboxWebhook", () => {
  beforeEach(() => {
    vi.mocked(verifyWebhook).mockReset();
    vi.mocked(verifyWebhook).mockReturnValue(true);
  });

  it("returns 400 when required headers are missing", async () => {
    const out = await handleInkboxWebhook(mailBody, {}, {
      signingKey: "whsec_x",
      handlers: {},
    });
    expect(out.status).toBe(400);
    expect(out.body).toContain("missing");
    expect(vi.mocked(verifyWebhook)).not.toHaveBeenCalled();
  });

  it("returns 403 when signature is invalid", async () => {
    vi.mocked(verifyWebhook).mockReturnValue(false);
    const out = await handleInkboxWebhook(mailBody, baseHeaders, {
      signingKey: "whsec_x",
      handlers: {},
    });
    expect(out.status).toBe(403);
  });

  it("returns 200 on a valid mail event and invokes onMail", async () => {
    const onMail = vi.fn();
    const out = await handleInkboxWebhook(mailBody, baseHeaders, {
      signingKey: "whsec_x",
      handlers: { onMail },
    });
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
    expect(onMail).toHaveBeenCalledTimes(1);
  });

  it("short-circuits duplicate request-ids after verifying", async () => {
    const dedup = new RequestIdDedup();
    const onMail = vi.fn();
    const opts = {
      signingKey: "whsec_x",
      handlers: { onMail },
      dedup,
    };
    const first = await handleInkboxWebhook(mailBody, baseHeaders, opts);
    expect(first.status).toBe(200);
    expect(onMail).toHaveBeenCalledTimes(1);

    // Second delivery of the same request-id.
    const second = await handleInkboxWebhook(mailBody, baseHeaders, opts);
    expect(second.status).toBe(200);
    expect(second.body).toBe("dup");
    // Handler must not fire again.
    expect(onMail).toHaveBeenCalledTimes(1);
    // HMAC still runs on duplicates so unauthenticated traffic cannot probe
    // or poison dedup state.
    expect(vi.mocked(verifyWebhook)).toHaveBeenCalledTimes(2);
  });

  it("does not let an invalid signature poison dedup state", async () => {
    const dedup = new RequestIdDedup();
    const onMail = vi.fn();
    const opts = {
      signingKey: "whsec_x",
      handlers: { onMail },
      dedup,
    };
    vi.mocked(verifyWebhook).mockReturnValueOnce(false).mockReturnValueOnce(true);

    const first = await handleInkboxWebhook(mailBody, baseHeaders, opts);
    expect(first.status).toBe(403);

    const second = await handleInkboxWebhook(mailBody, baseHeaders, opts);
    expect(second.status).toBe(200);
    expect(onMail).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent duplicate request-ids while dispatch is in-flight", async () => {
    const dedup = new RequestIdDedup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onMail = vi.fn(async () => {
      await gate;
    });
    const opts = {
      signingKey: "whsec_x",
      handlers: { onMail },
      dedup,
    };

    const first = handleInkboxWebhook(mailBody, baseHeaders, opts);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await handleInkboxWebhook(mailBody, baseHeaders, opts);

    expect(second.status).toBe(200);
    expect(second.body).toBe("dup");
    expect(onMail).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("returns 400 on invalid JSON body", async () => {
    const out = await handleInkboxWebhook("{not-json", baseHeaders, {
      signingKey: "whsec_x",
      handlers: {},
    });
    expect(out.status).toBe(400);
    expect(out.body).toContain("json");
  });

  it("returns the call decision as JSON for flat call payloads", async () => {
    const callBody = JSON.stringify({
      call_id: "c-1",
      remote_phone_number: "+15551234567",
      contacts: [{ id: "contact-1", name: "Ada" }],
      agent_identities: [],
    });
    const onCall = vi.fn().mockReturnValue({
      action: "answer",
      clientWebsocketUrl: "wss://example.com/ws",
    });
    const out = await handleInkboxWebhook(callBody, baseHeaders, {
      signingKey: "whsec_x",
      handlers: { onCall },
    });
    expect(out.status).toBe(200);
    expect(out.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(out.body!)).toEqual({
      action: "answer",
      clientWebsocketUrl: "wss://example.com/ws",
    });
  });

  it("does not remember a request-id when dispatch throws", async () => {
    const dedup = new RequestIdDedup();
    const onMail = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const opts = {
      signingKey: "whsec_x",
      handlers: { onMail },
      dedup,
    };
    // First call throws — handleInkboxWebhook should propagate so Inkbox
    // retries rather than silently swallowing the event.
    await expect(handleInkboxWebhook(mailBody, baseHeaders, opts)).rejects.toThrow();
    expect(dedup.has("req-1")).toBe(false);
  });
});
