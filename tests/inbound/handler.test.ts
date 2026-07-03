import { createHmac } from "node:crypto";
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

  it("delivers an Inkbox-signed unknown event type to onExternal as verified", async () => {
    const onExternal = vi.fn();
    const body = JSON.stringify({ event_type: "workflow_run.failed", title: "CI failed" });
    const out = await handleInkboxWebhook(body, baseHeaders, {
      signingKey: "whsec_x",
      handlers: { onExternal },
      externalEvents: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
    expect(onExternal).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "workflow_run.failed" }),
      { verified: true, requestId: "req-1" },
    );
  });

  it("ignores an Inkbox-signed unknown event type when external delivery is off", async () => {
    const onCall = vi.fn();
    const onExternal = vi.fn();
    const body = JSON.stringify({ event_type: "workflow_run.failed" });
    // onExternal is wired but the externalEvents opt-in is off — Inkbox-signed
    // unknown shapes stay gated on the flag.
    const out = await handleInkboxWebhook(body, baseHeaders, {
      signingKey: "whsec_x",
      handlers: { onCall, onExternal },
    });
    expect(out.status).toBe(200);
    expect(out.body).toBe("ignored");
    expect(onCall).not.toHaveBeenCalled();
    expect(onExternal).not.toHaveBeenCalled();
  });

  it("delivers an unsigned unknown-source payload as unverified when opted in", async () => {
    const onExternal = vi.fn();
    const body = JSON.stringify({ alert: "disk full" });
    const out = await handleInkboxWebhook(body, {}, {
      signingKey: "whsec_x",
      handlers: { onExternal },
      externalEvents: true,
    });
    expect(out.status).toBe(200);
    expect(onExternal).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "disk full" }),
      { verified: false },
    );
    // The Inkbox scheme must not run for a request Inkbox never claimed.
    expect(vi.mocked(verifyWebhook)).not.toHaveBeenCalled();
  });

  it("keeps the strict 400 for unknown sources when the opt-in is off", async () => {
    const onExternal = vi.fn();
    const body = JSON.stringify({ alert: "disk full" });
    // onExternal wired but externalEvents off: unknown/unverified senders may
    // not wake the agent.
    const out = await handleInkboxWebhook(body, {}, {
      signingKey: "whsec_x",
      handlers: { onExternal },
    });
    expect(out.status).toBe(400);
    expect(onExternal).not.toHaveBeenCalled();
  });

  describe("third-party provider requests", () => {
    const githubBody = JSON.stringify({ action: "completed", workflow_run: { id: 42 } });

    function githubHeaders(secret: string, body: string): Record<string, string> {
      const digest = createHmac("sha256", secret).update(body).digest("hex");
      return { "x-hub-signature-256": `sha256=${digest}` };
    }

    beforeEach(() => {
      delete process.env.INKBOX_WEBHOOK_SECRET_GITHUB;
    });

    it("verifies a GitHub-signed request and delivers it verified", async () => {
      process.env.INKBOX_WEBHOOK_SECRET_GITHUB = "gh-secret";
      const onExternal = vi.fn();
      const out = await handleInkboxWebhook(githubBody, githubHeaders("gh-secret", githubBody), {
        signingKey: "whsec_x",
        handlers: { onExternal },
      });
      expect(out.status).toBe(200);
      expect(onExternal).toHaveBeenCalledWith(
        expect.objectContaining({ action: "completed" }),
        { verified: true },
      );
    });

    it("rejects a GitHub request whose signature does not verify", async () => {
      process.env.INKBOX_WEBHOOK_SECRET_GITHUB = "gh-secret";
      const onExternal = vi.fn();
      const out = await handleInkboxWebhook(githubBody, githubHeaders("wrong-secret", githubBody), {
        signingKey: "whsec_x",
        handlers: { onExternal },
      });
      expect(out.status).toBe(401);
      expect(onExternal).not.toHaveBeenCalled();
    });

    it("fails closed when the provider secret is not configured", async () => {
      const onExternal = vi.fn();
      const out = await handleInkboxWebhook(githubBody, githubHeaders("gh-secret", githubBody), {
        signingKey: "whsec_x",
        handlers: { onExternal },
      });
      expect(out.status).toBe(401);
      expect(onExternal).not.toHaveBeenCalled();
    });

    it("delivers a verified provider event even when the externalEvents flag is off", async () => {
      // Configuring the provider's secret IS that source's opt-in; the
      // externalEvents flag only gates unverified/unknown senders.
      process.env.INKBOX_WEBHOOK_SECRET_GITHUB = "gh-secret";
      const onExternal = vi.fn();
      const out = await handleInkboxWebhook(githubBody, githubHeaders("gh-secret", githubBody), {
        signingKey: "whsec_x",
        handlers: { onExternal },
        externalEvents: false,
      });
      expect(out.status).toBe(200);
      expect(out.body).toBe("ok");
      expect(onExternal).toHaveBeenCalledWith(
        expect.objectContaining({ action: "completed" }),
        { verified: true },
      );
    });

    it("acknowledges without dispatch when no external delivery path is wired", async () => {
      process.env.INKBOX_WEBHOOK_SECRET_GITHUB = "gh-secret";
      const out = await handleInkboxWebhook(githubBody, githubHeaders("gh-secret", githubBody), {
        signingKey: "whsec_x",
        handlers: {},
      });
      expect(out.status).toBe(200);
      expect(out.body).toBe("ignored");
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
