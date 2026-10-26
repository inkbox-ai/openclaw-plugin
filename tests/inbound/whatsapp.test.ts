import { createHmac } from "node:crypto";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return {
    statePaths: () => ({ dir: state.dir }),
    ensureStateDir: () => fs.mkdir(state.dir, { recursive: true, mode: 0o700 }),
  };
});
vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: () => ({
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "contact:example",
    },
    buildEnvelope: ({ body }: any) => ({ storePath: "memory:test", body }),
  }),
}));
import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
function fixture() {
  const identity: any = {
    id: "11111111-1111-4111-8111-111111111111",
    getWhatsAppStatus: vi.fn(async () => ({ enabled: true, status: "ready" })),
    sendWhatsApp: vi.fn(async () => ({
      id: "sent-a",
      conversationId: "conversation-a",
      status: "queued",
      deliveryState: "pending",
    })),
    getWhatsAppMedia: vi.fn(async () => ({
      id: "media-a",
      status: "unavailable",
      url: null,
    })),
  };
  const runtime: any = {
    getIdentity: async () => identity,
    getClient: async () => ({ contacts: { lookup: async () => [] } }),
  };
  const dispatchReply = vi.fn(async (p: any) => {
    await p.delivery.deliver({ text: "WhatsApp answer" }, { kind: "final" });
    return { dispatched: true };
  });
  const core: any = {
    inbound: { buildContext: vi.fn((p) => p), dispatchReply },
    session: { recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  };
  const options: any = {
    cfg: {},
    account: {
      accountId: "default",
      identity: "example",
      config: { identity: "example" },
    },
    runtime,
    channelRuntime: core,
  };
  const bridge = () => createInkboxSessionBridge(options);
  return { identity, runtime, core, dispatchReply, bridge };
}
const event = (
  identityId = "11111111-1111-4111-8111-111111111111",
  id = "event-a",
  conversation = "conversation-a",
): any => ({
  id,
  event_type: "whatsapp.received",
  timestamp: "2026-10-26T09:00:00Z",
  data: {
    message: {
      id: "message-a",
      agent_identity_id: identityId,
      conversation_id: conversation,
      direction: "inbound",
      local_number: "+15555550100",
      remote_number: "+15555550123",
      sender_number: "+15555550123",
      participants: ["+15555550123"],
      is_group: false,
      content: "Please review the brief",
      media: [],
    },
    contacts: [],
    agent_identities: [],
  },
});
async function settle(b: any) {
  await b.catchUpCompanion();
  await b.catchUpCompanion();
}
beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "inkbox-whatsapp-test-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(state.dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
});
vi.setConfig({ testTimeout: 30000 });
describe("WhatsApp native receive/reply", () => {
  it("verifies the actual SDK signature before durable WhatsApp acceptance", async () => {
    const f = fixture(),
      b = f.bridge(),
      body = JSON.stringify(event());
    const headers = {
      "x-inkbox-request-id": "request-a",
      "x-inkbox-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-inkbox-signature": "invalid",
    };
    expect(
      (
        await handleInkboxWebhook(body, headers, {
          signingKey: "synthetic-key",
          handlers: b.handlers,
        })
      ).status,
    ).toBe(403);
    expect(f.dispatchReply).not.toHaveBeenCalled();
    headers["x-inkbox-signature"] =
      "sha256=" +
      createHmac("sha256", "synthetic-key")
        .update(
          `${headers["x-inkbox-request-id"]}.${headers["x-inkbox-timestamp"]}.${body}`,
        )
        .digest("hex");
    expect(
      (
        await handleInkboxWebhook(body, headers, {
          signingKey: "synthetic-key",
          handlers: b.handlers,
        })
      ).status,
    ).toBe(200);
    await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
  });

  it("uses the durable ordinary queue, retains the exact source and deduplicates across restart", async () => {
    const f = fixture(),
      b = f.bridge();
    await dispatchInbound(event(), b.handlers);
    await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(f.identity.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-a",
        text: "WhatsApp answer",
        idempotencyKey: expect.stringContaining("openclaw:whatsapp:"),
      }),
    );
    const next = f.bridge();
    await dispatchInbound(event(), next.handlers);
    await settle(next);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    expect(f.core.inbound.buildContext.mock.calls[0][0].extra.InkboxMode).toBe(
      "whatsapp",
    );
  });
  it("keeps concurrent conversation ownership separate and records late status without another turn", async () => {
    const f=fixture(), b=f.bridge();
    f.identity.sendWhatsApp.mockImplementation(async (p:any)=>({id:`sent-${p.conversationId}`,conversationId:p.conversationId,status:"sent",deliveryState:"pending"}));
    const a=event(undefined,"event-a","conversation-a"), c=event(undefined,"event-b","conversation-b");c.data.message.id="message-b";
    await Promise.all([dispatchInbound(a,b.handlers),dispatchInbound(c,b.handlers)]);await settle(b);
    expect(f.identity.sendWhatsApp.mock.calls.map(([p]:any)=>p.conversationId).sort()).toEqual(["conversation-a","conversation-b"]);
    const receipt=event(undefined,"receipt-a");receipt.event_type="whatsapp.delivery_unconfirmed";receipt.data.message.id="sent-conversation-a";receipt.data.message.status="sent";receipt.data.message.delivery_state="unknown";
    await dispatchInbound(receipt,b.handlers);await settle(b);expect(f.dispatchReply).toHaveBeenCalledTimes(2);expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
    const files=await readdir(state.dir);const contexts=files.filter(n=>n.startsWith("group-context-"));expect(contexts.length).toBeGreaterThan(0);
    expect((await Promise.all(contexts.map(n=>readFile(join(state.dir,n),"utf8")))).join("")).toContain("delivery_unconfirmed");
  });
  it("keeps media-only unavailable attachments explicit rather than dropping the turn", async () => {
    const f = fixture(),
      b = f.bridge(),
      e = event();
    e.data.message.content = null;
    e.data.message.media = [
      {
        id: "media-a",
        filename: "brief.pdf",
        content_type: "application/pdf",
        size: 10,
        status: "unavailable",
        url: null,
      },
    ];
    await dispatchInbound(e, b.handlers);
    await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(f.core.inbound.buildContext.mock.calls[0][0]),
    ).toContain("unavailable");
    expect(f.identity.getWhatsAppMedia).toHaveBeenCalledWith("media-a");
  });
  it("treats lifecycle and unknown WhatsApp events as status only, never external/model work", async () => {
    const f = fixture(),
      b = f.bridge();
    for (const type of [
      "whatsapp.sent",
      "whatsapp.delivered",
      "whatsapp.delivery_failed",
      "whatsapp.delivery_unconfirmed",
      "whatsapp.unknown",
    ]) {
      const e = event();
      e.event_type = type;
      await dispatchInbound(e, {
        ...b.handlers,
        onExternal: vi.fn(() => {
          throw Error("must not route external");
        }),
      });
    }
    await settle(b);
    expect(f.dispatchReply).not.toHaveBeenCalled();
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  });
  it("refuses a foreign identity and group-shaped payload before dispatch", async () => {
    const f = fixture(),
      b = f.bridge();
    await expect(
      dispatchInbound(event("another-identity"), b.handlers),
    ).rejects.toThrow(/identity mismatch/);
    const e = event();
    e.data.message.is_group = true;
    await expect(dispatchInbound(e, b.handlers)).rejects.toThrow(
      /direct WhatsApp source/,
    );
    expect(f.dispatchReply).not.toHaveBeenCalled();
  });
  it("retains an uncertain accepted answer and never regenerates or resends it on restart", async () => {
    const f = fixture(),
      b = f.bridge();
    f.identity.sendWhatsApp.mockRejectedValue(new TypeError("response lost"));
    await dispatchInbound(event(), b.handlers);
    await settle(b);
    const next = f.bridge();
    await dispatchInbound(event(), next.handlers);
    await settle(next);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    const files = await readdir(state.dir);
    const journal = files.find(
      (n) => n.startsWith("companion-") && n.endsWith(".json"),
    )!;
    expect(await readFile(join(state.dir, journal), "utf8")).toContain(
      "WhatsApp answer",
    );
  });
});
