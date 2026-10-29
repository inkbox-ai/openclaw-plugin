import { createHash, createHmac } from "node:crypto";
import { InkboxAPIError } from "@inkbox/sdk";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { createCompanionReceiver } from "../../src/inbound/companion.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { bindNativeSource } from "../../src/native-source.js";
import { registerSendIMessage } from "../../src/tools/send-imessage.js";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
function fixture() {
  const identity: any = {
    id: "11111111-1111-4111-8111-111111111111",
    getWhatsAppStatus: vi.fn(async () => ({ enabled: true, status: "ready" })),
    getWhatsAppConversation: vi.fn(async () => ({ agentIdentityId: "11111111-1111-4111-8111-111111111111", isGroup: true, participants: ["+15555550123", "+15555550124"], unresolvedParticipantCount: 0 })),
    sendWhatsApp: vi.fn(async () => ({
      id: "sent-a",
      conversationId: "00000000-0000-4000-8000-000000000001",
      status: "queued",
      deliveryState: "pending",
    })),
    getWhatsAppMedia: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000004",
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
  conversation = "00000000-0000-4000-8000-000000000001",
): any => ({
  id,
  event_type: "whatsapp.received",
  timestamp: "2026-10-26T09:00:00Z",
  data: {
    message: {
      id: "00000000-0000-4000-8000-000000000005",
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
        conversationId: "00000000-0000-4000-8000-000000000001",
        text: "WhatsApp answer",
        replyToMessageId: "00000000-0000-4000-8000-000000000005",
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
    const a=event(undefined,"event-a","00000000-0000-4000-8000-000000000001"), c=event(undefined,"event-b","00000000-0000-4000-8000-000000000002");c.data.message.id="message-b";
    await Promise.all([dispatchInbound(a,b.handlers),dispatchInbound(c,b.handlers)]);await settle(b);
    expect(f.identity.sendWhatsApp.mock.calls.map(([p]:any)=>p.conversationId).sort()).toEqual(["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]);
    const receipt=event(undefined,"receipt-a");receipt.event_type="whatsapp.delivery_unconfirmed";receipt.data.message.id="sent-00000000-0000-4000-8000-000000000001";receipt.data.message.status="sent";receipt.data.message.delivery_state="unknown";
    await dispatchInbound(receipt,b.handlers);await settle(b);expect(f.dispatchReply).toHaveBeenCalledTimes(2);expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
    const files=await readdir(state.dir);const contexts=files.filter(n=>n.startsWith("companion-") && n.endsWith(".json"));expect(contexts.length).toBeGreaterThan(0);
    expect((await Promise.all(contexts.map(n=>readFile(join(state.dir,n),"utf8")))).join("")).toContain("delivery_unconfirmed");
    const next=event(undefined,"event-c");next.data.message.id="message-c";
    await dispatchInbound(next,b.handlers);await settle(b);
    expect(JSON.stringify(f.core.inbound.buildContext.mock.calls[2][0])).toContain("delivery_unconfirmed");
    const later=event(undefined,"event-d");later.data.message.id="message-d";
    await dispatchInbound(later,b.handlers);await settle(b);
    expect(JSON.stringify(f.core.inbound.buildContext.mock.calls[3][0])).not.toContain("delivery_unconfirmed");
  });
  it("keeps media-only unavailable attachments explicit rather than dropping the turn", async () => {
    const f = fixture(),
      b = f.bridge(),
      e = event();
    e.data.message.content = null;
    e.data.message.media = [
      {
        id: "00000000-0000-4000-8000-000000000004",
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
    expect(f.identity.getWhatsAppMedia).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000004");
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
  it("refuses a foreign identity and an unresolved group author before dispatch", async () => {
    const f = fixture(),
      b = f.bridge();
    await expect(
      dispatchInbound(event("another-identity"), b.handlers),
    ).rejects.toThrow(/identity mismatch/);
    const e = event();
    e.data.message.is_group = true;
    e.data.message.sender_number = null;
    await expect(dispatchInbound(e, b.handlers)).resolves.toMatchObject({ kind: "whatsapp" });
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
  it("recovers a journaled unknown tool send by key after restart without regenerating or resending", async () => {
    const f = fixture();
    const lookup = vi.fn(async () => undefined as string | undefined);
    const model = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      await input.beforeToolSend("original-call", { idempotencyKey: "original-logical-key", text: "Saved answer" });
      return ["Saved answer"];
    });
    const deliver = vi.fn(async () => "must-not-send");
    const options: any = { accountId: "default", config: { identity: "example" },
      runtime: { getIdentity: async () => f.identity, getClient: async () => ({ messageSends: { lookup } }) }, submit: model, deliver };
    const first = createCompanionReceiver(options), incoming = event();
    incoming._openclawWhatsApp = true;
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000001" };
    incoming.data.message._ordinaryAddressed = true;
    await first.accept(incoming); await first.idle(); first.close();
    const path = (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!;
    expect(await readFile(join(state.dir, path), "utf8")).toContain("original-logical-key");
    const unavailable = createCompanionReceiver({ ...options, runtime: { ...options.runtime, getClient: async () => { throw new Error("Client unavailable"); } } });
    await expect(unavailable.recover()).resolves.toBeUndefined(); unavailable.close();
    expect(deliver).not.toHaveBeenCalled();
    lookup.mockResolvedValue("accepted-original-message");
    const next = createCompanionReceiver(options); await next.recover(); await next.idle(); next.close();
    expect(lookup).toHaveBeenCalledWith({ senderKind: "whatsapp_identity", senderId: f.identity.id, operation: "whatsapp.send", idempotencyKey: "original-logical-key" });
    expect(model).toHaveBeenCalledOnce(); expect(deliver).not.toHaveBeenCalled();
    expect(await next.whatsappDeliveryConversation("accepted-original-message")).toBe("00000000-0000-4000-8000-000000000001");
  });

  it.each([
    ["+15555550123", false],
    ["+15555550123", true],
    [" +1 (555) 555-0123 ", false],
    ["+15555550124", false],
  ])("tracks explicit recipient replies without duplicating the final (%s, uncertain=%s)", async (to, uncertain) => {
    const f = fixture(), bound = to !== "+15555550124";
    f.identity.getWhatsAppConversation = vi.fn(async () => ({
      agentIdentityId: f.identity.id, isGroup: false, participants: ["+15555550123"],
    }));
    if (uncertain) f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
    const deliver = vi.fn(async () => "ordinary-final");
    let submitError: unknown;
    const submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      const release = bindNativeSource("explicit-recipient-source", {
        whatsapp: true, sourceMessageId: input.messageId, identityId: f.identity.id,
        conversationId: input.reply.conversationId, author: input.author, closed: false,
        validate: input.validateBeforeDispatch, beforeSend: input.beforeToolSend,
        afterSend: input.afterToolSend, rejectSend: input.rejectToolSend,
      });
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) {
          const tool = typeof def === "function" ? def({ sessionKey: "explicit-recipient-source" }) : def;
          tools.set(tool.name, tool);
        } }, f.runtime);
        const result = await tools.get("inkbox_send_whatsapp").execute("explicit-call", { to, text: "Saved answer" });
        expect(Boolean(result.isError)).toBe(uncertain);
        return ["Saved answer"];
      } catch (error) { submitError = error; throw error; }
      finally { release(); }
    });
    const receiver = createCompanionReceiver({ accountId: "default", config: { identity: "example" },
      runtime: f.runtime, submit, deliver });
    const incoming = event();
    incoming._openclawWhatsApp = true;
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000001" };
    incoming.data.message._ordinaryAddressed = true;
    try {
      await receiver.accept(incoming); await receiver.idle();
      expect(submitError).toBeUndefined();
      expect(submit).toHaveBeenCalledOnce();
      expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledTimes(bound || uncertain ? 0 : 1);
      if (bound && !uncertain) expect(await receiver.whatsappDeliveryConversation("sent-a")).toBe("00000000-0000-4000-8000-000000000001");
    } finally { receiver.close(); }
  });

  async function exerciseRejectedSend(failure: Error, rejected: boolean, retry = true) {
    const f = fixture();
    f.identity.getWhatsAppConversation = vi.fn(async () => ({
      agentIdentityId: f.identity.id, isGroup: false, participants: ["+15555550123"],
    }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(failure);
    const deliver = vi.fn(async () => "must-not-send");
    const lookup = vi.fn(async () => undefined);
    let submitError: unknown;
    const readJournal = async () => {
      const name = (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!;
      return JSON.parse(await readFile(join(state.dir, name), "utf8"));
    };
    const submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      const release = bindNativeSource("quota-owned-source", {
        whatsapp: true, sourceMessageId: input.messageId, identityId: f.identity.id,
        conversationId: input.reply.conversationId, author: input.author, closed: false,
        validate: input.validateBeforeDispatch, beforeSend: input.beforeToolSend,
        afterSend: input.afterToolSend, rejectSend: input.rejectToolSend,
      });
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) {
          const tool = typeof def === "function" ? def({ sessionKey: "quota-owned-source" }) : def;
          tools.set(tool.name, tool);
        } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        const payload = { text: "Saved answer", mediaIds: ["00000000-0000-4000-8000-000000000009"], idempotencyKey: "original-logical-key" };
        const first = await send.execute("first-call", payload);
        expect(first.isError).toBe(true);
        const saved = Object.values((await readJournal()).jobs)[0] as any;
        expect(saved.toolSends["first-call"]).toMatchObject({
          whatsappKey: "original-logical-key", whatsappMediaIds: ["00000000-0000-4000-8000-000000000009"], text: "Saved answer",
        });
        expect(saved.toolSends["first-call"].whatsappRejection?.error).toBe(rejected ? "whatsapp_daily_limit_exceeded" : undefined);
        expect(first.details?.requestAccepted).toBe(rejected ? false : undefined);
        if (rejected) {
          expect(first.details).toEqual({ error: "whatsapp_daily_limit_exceeded", status_code: 429,
            quota: "whatsapp.texts_per_agent_identity_per_24h", limit: 50, used: 50,
            retry_condition: "window_reset", reset_at: "2026-10-27T00:00:00Z", retry_after_seconds: 60,
            idempotencyKey: "original-logical-key", requestAccepted: false, mediaIds: ["00000000-0000-4000-8000-000000000009"] });
          expect(JSON.stringify(first)).not.toContain("private-provider-note");
          for (const changed of [{ ...payload, idempotencyKey: "new-key" }, { ...payload, text: "Changed answer" }, { ...payload, mediaIds: ["00000000-0000-4000-8000-000000000010"] }]) {
            const blocked = await send.execute("changed-intent", changed);
            expect(blocked.isError).toBe(true);
            expect(blocked.details.idempotencyKey).toBe("original-logical-key");
            expect(blocked.content[0].text).toContain("rejected/not accepted");
            expect(blocked.content[0].text).toContain("window_reset");
          }
        }
        if (!retry) return ["Saved answer"];
        const retried = await send.execute("retry-call", payload);
        if (rejected) {
          expect(retried.isError).not.toBe(true);
          expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
          expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual(f.identity.sendWhatsApp.mock.calls[1][0]);
          const accepted = Object.values((await readJournal()).jobs)[0] as any;
          expect(accepted.toolSends["retry-call"].messageId).toBe("sent-a");
        } else {
          expect(retried.isError).toBe(true);
          expect(retried.details).toMatchObject({ sendAttempted: false, idempotencyKey: "original-logical-key" });
          expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
        }
        return ["Saved answer"];
      } catch (error) { submitError = error; throw error; }
      finally { release(); }
    });
    const options: any = { accountId: "default", config: { identity: "example" }, submit, deliver,
      runtime: { ...f.runtime, getClient: async () => ({ messageSends: { lookup } }) } };
    const receiver = createCompanionReceiver(options);
    const incoming = event();
    incoming._openclawWhatsApp = true;
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000001" };
    incoming.data.message._ordinaryAddressed = true;
    try {
      await receiver.accept(incoming);
      await receiver.idle();
      expect(submit).toHaveBeenCalledOnce();
      expect(submitError).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
      if (rejected && retry) {
        expect(Object.keys((await readJournal()).jobs)).toHaveLength(0);
        expect(await receiver.whatsappDeliveryConversation("sent-a")).toBe("00000000-0000-4000-8000-000000000001");
      } else {
        const saved = Object.values((await readJournal()).jobs)[0] as any;
        expect(saved.state).toBe("paused");
        if (rejected) {
          expect(saved.reason).toContain("rejected/not accepted");
          expect(saved.reason).toContain("original-logical-key");
          expect(saved.reason).toContain("window_reset");
          expect(saved.reason).not.toContain("uncertain");
          await receiver.recover();
          const context = JSON.stringify((await readJournal()).context);
          expect(context).toContain("rejected/not accepted");
          expect(context).not.toContain("Prior turn outcome is uncertain");
          expect(lookup).not.toHaveBeenCalled();
          expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
        }
      }
    } finally { receiver.close(); }
  }

  it("durably retries a known pre-admission quota rejection only with the original key and owned media", async () => {
    await exerciseRejectedSend(new InkboxAPIError(429, {
      error: "whatsapp_daily_limit_exceeded", quota: "whatsapp.texts_per_agent_identity_per_24h",
      limit: 50, used: 50, retry_condition: "window_reset", reset_at: "2026-10-27T00:00:00Z",
      message: "private-provider-note", provider: { diagnostic: "private-provider-note" },
    }, "60"), true);
  });

  it("retains known rejected saved replies honestly without lookup or a new automatic send", async () => {
    await exerciseRejectedSend(new InkboxAPIError(429, {
      error: "whatsapp_daily_limit_exceeded", quota: "whatsapp.texts_per_agent_identity_per_24h",
      limit: 50, used: 50, retry_condition: "window_reset", reset_at: "2026-10-27T00:00:00Z",
      message: "private-provider-note",
    }, "60"), true, false);
  });

  it.each([
    new InkboxAPIError(409, { error: "whatsapp_send_pending" }),
    new InkboxAPIError(429, { error: "whatsapp_unknown_policy" }),
    new InkboxAPIError(503, { error: "whatsapp_daily_limit_exceeded" }),
    new TypeError("response lost"),
  ])("keeps ambiguous or unrecognized rejection fenced (%s)", async (failure) => {
    await exerciseRejectedSend(failure, false);
  });

});


describe("WhatsApp v2 native group admission", () => {
  it("uses conversation-scoped group routing, retains quote metadata, and anchors automatic replies to the triggering message", async () => {
    const f = fixture(), b = f.bridge(), e = event();
    e.data.message.is_group = true;
    e.data.message.participants = ["+15555550123", "+15555550124"];
    e.data.message.thread_id = "thread-a";
    e.data.message.reply_to_message_id = "parent-a";
    await dispatchInbound(e, b.handlers); await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    const built = f.core.inbound.buildContext.mock.calls[0][0];
    expect(JSON.stringify(built)).toContain("group");
    expect(JSON.stringify(built)).toContain("parent-a");
    expect(JSON.stringify(built)).toContain("thread-a");
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ conversationId: "00000000-0000-4000-8000-000000000001" });
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toHaveProperty("replyToMessageId", "00000000-0000-4000-8000-000000000005");
  });
  it("preserves group mention admission rather than waking for every peer message", async () => {
    const f = fixture(), b = createInkboxSessionBridge({ cfg: {}, account: { accountId: "default", identity: "example", config: { identity: "example", groupReplyMode: "mention" } }, runtime: f.runtime, channelRuntime: f.core } as any);
    const e = event(); e.data.message.is_group = true; e.data.message.participants = ["+15555550123", "+15555550124"]; e.data.message.sender_access = "direct";
    await dispatchInbound(e, b.handlers); await settle(b);
    expect(f.dispatchReply).not.toHaveBeenCalled();
    const mentioned = event(undefined, "mentioned"); mentioned.data.message = { ...e.data.message, id: "mentioned-message", content: "@example please answer" };
    await dispatchInbound(mentioned, b.handlers); await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
  });
  it("admits peer reaction transitions into the original group once, without treating the target as a new command", async () => {
    const f = fixture(), b = f.bridge(), e = event();
    e.event_type = "whatsapp.reaction_received"; e.data.message.is_group = true; e.data.message.direction = "outbound"; e.data.message.participants = ["+15555550123", "+15555550124"]; e.data.message.sender_access = "direct";
    e.data.reaction = { id: "reaction-a", target_message_id: e.data.message.id, conversation_id: "00000000-0000-4000-8000-000000000001", agent_identity_id: f.identity.id, direction: "inbound", remote_number: "+15555550123", emoji: "👀", status: "applied", revision: 1 };
    await dispatchInbound(e, b.handlers); await settle(b); await dispatchInbound(e, b.handlers); await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.core.inbound.buildContext.mock.calls[0][0])).toContain("context, not a new instruction");
    expect(f.core.inbound.buildContext.mock.calls[0][0].message.inboundEventKind).toBe("room_event");
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).not.toHaveProperty("replyToMessageId");
    const own = structuredClone(e); own.id = "own-event"; own.data.reaction.id = "own-reaction"; own.data.reaction.direction = "outbound";
    await dispatchInbound(own, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledOnce();
    const hidden = structuredClone(e); hidden.id = "hidden-event"; hidden.data.message.is_blocked = true; hidden.data.reaction.id = "hidden-reaction";
    await dispatchInbound(hidden, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledOnce();
    const removed = structuredClone(e); removed.id = "removed-event"; removed.data.reaction.revision = 2; removed.data.reaction.status = "removed";
    await dispatchInbound(removed, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledTimes(2);
  });
});


it("blocks automatic group answers, including saved-answer recovery, for any disallowed peer", async () => {
  const f = fixture();
  const options: any = { cfg: {}, account: { accountId: "default", identity: "example", config: { identity: "example", allowedRecipients: ["+15555550123"] } }, runtime: f.runtime, channelRuntime: f.core };
  const e = event(); e.data.message.is_group = true; e.data.message.participants = ["+15555550123", "+15555550124"];
  const first = createInkboxSessionBridge(options); await dispatchInbound(e, first.handlers); await settle(first);
  expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  const next = createInkboxSessionBridge(options); await settle(next);
  expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
});
it("keeps a recovered uncertain explicit quote fenced against reformatted plain final answers", async () => {
  const f = fixture(), lookup = vi.fn(async () => "accepted-quote");
  f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
  f.dispatchReply.mockImplementation(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    await tools.get("inkbox_send_whatsapp").execute("quoted-attempt", { conversationId: "00000000-0000-4000-8000-000000000001", replyToMessageId: "00000000-0000-4000-8000-000000000008", text: "Answer\n", idempotencyKey: "original-quote-key" });
    await input.delivery.deliver({ text: "Answer" }, { kind: "final" }); return { dispatched: true };
  });
  const first = f.bridge(); await dispatchInbound(event(), first.handlers); await settle(first);
  const next = f.bridge(); await settle(next);
  expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalled();
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ replyToMessageId: "00000000-0000-4000-8000-000000000008", text: "Answer\n", idempotencyKey: "original-quote-key" });
});


it("retains an overlong saved reply as not attempted, never as a delivery-uncertain send", async () => {
  const f = fixture();
  f.dispatchReply.mockImplementationOnce(async (input: any) => { await input.delivery.deliver({ text: "x".repeat(4001) }, { kind: "final" }); return { dispatched: true }; });
  const first = f.bridge(); await dispatchInbound(event(), first.handlers); await settle(first);
  expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  const next = f.bridge(); await settle(next);
  const fresh = event(undefined, "new-event"); fresh.data.message.id = "new-message";
  await dispatchInbound(fresh, next.handlers); await settle(next);
  const context = JSON.stringify(f.core.inbound.buildContext.mock.calls.at(-1)[0]);
  expect(context).toContain("automatic WhatsApp reply was not attempted");
  expect(context).not.toContain("Prior turn outcome is uncertain");
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
});


it("admits the canonical reaction webhook only with a resolved permitted actor and never replays target text", async () => {
  const shared = JSON.parse(await readFile(new URL("../fixtures/whatsapp-v2.json", import.meta.url), "utf8"));
  const f = fixture(); f.identity.id = shared.message.agent_identity_id;
  const bridge = f.bridge(), raw = structuredClone(shared.reaction_webhook);
  await dispatchInbound(raw, bridge.handlers); await settle(bridge); expect(f.dispatchReply).not.toHaveBeenCalled();
  raw.id = "evt-resolved-reaction"; raw.data.reaction.remote_number = shared.message.participants[0];
  await dispatchInbound(raw, bridge.handlers); await settle(bridge);
  expect(f.dispatchReply).toHaveBeenCalledOnce();
  const context = JSON.stringify(f.core.inbound.buildContext.mock.calls[0][0]);
  expect(context).toContain("context, not a new instruction"); expect(context).not.toContain(shared.message.content);
});


it("replays a legacy saved plain reply with its exact original hash after restart", async () => {
  const f = fixture();
  const beforeSend = f.identity.getWhatsAppStatus;
  beforeSend.mockImplementation(async () => { throw new Error("temporarily unavailable"); });
  const first = f.bridge();
  await dispatchInbound(event(), first.handlers); await settle(first);
  const filename = (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!;
  const path = join(state.dir, filename), journal = JSON.parse(await readFile(path, "utf8"));
  const id = Object.keys(journal.jobs)[0]!, job = journal.jobs[id];
  job.state = "reply_pending"; job.nativeComplete = true; job.sendUnconfirmed = false;
  job.replies = ["Legacy answer"]; job.reply = { channel: "whatsapp", identityId: f.identity.id, conversationId: "00000000-0000-4000-8000-000000000001" };
  delete job.retryAt;
  await writeFile(path, JSON.stringify(journal));
  beforeSend.mockResolvedValue({ enabled: true, status: "ready" });
  const restarted = f.bridge(); await settle(restarted);
  const key = `openclaw:whatsapp:${createHash("sha256").update(JSON.stringify([
    f.identity.id, id, "00000000-0000-4000-8000-000000000001", "Legacy answer",
  ])).digest("hex")}`;
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp).toHaveBeenCalledWith({ conversationId: "00000000-0000-4000-8000-000000000001",
    text: "Legacy answer", idempotencyKey: key });
  expect(f.dispatchReply).not.toHaveBeenCalled();
});


it.each(["accepted", "uncertain", "rejected"])("inherits a tool quote and suppresses changed final output across restart (%s)", async (outcome) => {
  const f = fixture();
  const lookup = vi.fn(async () => "accepted-original");
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
  if (outcome === "uncertain") f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("lost response"));
  if (outcome === "rejected") f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
  let caught: unknown;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    try {
      const tools = new Map<string, any>();
      registerWhatsAppTools({ registerTool(def: any) {
        const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def;
        tools.set(tool.name, tool);
      } }, f.runtime);
      const send = tools.get("inkbox_send_whatsapp");
      const result = await send.execute("first", { text: "Tool answer" });
      expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({
        conversationId: "00000000-0000-4000-8000-000000000001", replyToMessageId: "00000000-0000-4000-8000-000000000005", text: "Tool answer" });
      if (outcome !== "accepted") {
        const originalKey = result.details.idempotencyKey;
        const replacement = await send.execute("replacement", { text: "Replacement", idempotencyKey: "new-key" });
        expect(replacement.isError).toBe(true);
        expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
        const retry = await send.execute("retry", { text: "Tool answer", idempotencyKey: originalKey });
        if (outcome === "rejected") {
          expect(retry.isError).not.toBe(true);
          expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual(f.identity.sendWhatsApp.mock.calls[1][0]);
        } else expect(retry.isError).toBe(true);
      }
      await input.delivery.deliver({ text: "Changed final answer" }, { kind: "final" });
    } catch (error) { caught = error; throw error; }
    return { dispatched: true };
  });
  const first = f.bridge(); await dispatchInbound(event(), first.handlers); await settle(first);
  const restarted = f.bridge(); await settle(restarted);
  expect(caught).toBeUndefined();
  expect(f.dispatchReply).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(outcome === "rejected" ? 2 : 1);
});

it.each(["lost-response", "uncertain-response"])("fences a plain source send from a changed final after recovery (%s)", async (outcome) => {
  const f = fixture(), lookup = vi.fn(async () => "accepted-plain");
  let retry: any;
  if (outcome === "lost-response") f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  else f.identity.sendWhatsApp.mockResolvedValueOnce({ id: "accepted-plain", conversationId: "00000000-0000-4000-8000-000000000001", status: "uncertain" });
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
  f.dispatchReply.mockImplementation(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    await tools.get("inkbox_send_whatsapp").execute("plain-attempt", { conversationId: "00000000-0000-4000-8000-000000000001", text: "Answer\n", idempotencyKey: "original-plain-key" });
    retry = await tools.get("inkbox_send_whatsapp").execute("new-attempt", { conversationId: "00000000-0000-4000-8000-000000000001", text: "Answer", idempotencyKey: "replacement-key" });
    await input.delivery.deliver({ text: "Answer" }, { kind: "final" }); return { dispatched: true };
  });
  const first = f.bridge(); await dispatchInbound(event(), first.handlers); await settle(first);
  const next = f.bridge(); await settle(next); await settle(f.bridge());
  expect(f.dispatchReply).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual({ conversationId: "00000000-0000-4000-8000-000000000001", text: "Answer\n", idempotencyKey: "original-plain-key" });
  expect(retry.isError).toBe(true);
  expect(retry.details).toMatchObject({ sendAttempted: false, idempotencyKey: "original-plain-key" });
  if (outcome === "lost-response") expect(lookup).toHaveBeenCalled();
});

it("allows explicit permitted iMessage outreach in a WhatsApp turn with iMessage threading disabled", async () => {
  const f = fixture();
  f.identity.sendIMessage = vi.fn(async () => ({ id: "imessage-send", status: "sent" }));
  f.dispatchReply.mockImplementation(async (input: any) => {
    let tool: any;
    registerSendIMessage({ registerTool(def: any) { tool = def({ sessionKey: input.routeSessionKey }); } }, f.runtime, ["+15555550124"], () => false);
    expect((await tool.execute("outreach", { to: "+15555550124", text: "Requested outreach" })).isError).not.toBe(true);
    expect((await tool.execute("blocked", { to: "+15555550125", text: "Blocked outreach" })).isError).toBe(true);
    expect((await tool.execute("implicit", { text: "No destination" })).isError).toBe(true);
    await input.delivery.deliver({ text: "WhatsApp answer" }, { kind: "final" }); return { dispatched: true };
  });
  const b = f.bridge(); await dispatchInbound(event(), b.handlers); await settle(b);
  expect(f.identity.sendIMessage).toHaveBeenCalledOnce();
  expect(f.identity.sendIMessage).toHaveBeenCalledWith({ to: "+15555550124", text: "Requested outreach" });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
});

it.each(["automatic", "tool", "lookup"])("retains authenticated early lifecycle context exactly once after %s ownership", async (mode) => {
  const f = fixture(), b = f.bridge();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const lookup = vi.fn(async () => undefined as string | undefined);
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
  f.identity.sendWhatsApp.mockImplementationOnce(async () => {
    entered(); await held;
    if (mode === "lookup") throw new TypeError("response lost");
    return { id: "early-send", conversationId: "00000000-0000-4000-8000-000000000001", status: "queued" };
  });
  if (mode !== "automatic") f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    await tools.get("inkbox_send_whatsapp").execute("held-send", { text: "Answer", idempotencyKey: "held-key" });
    await input.delivery.deliver({ text: "Answer" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), b.handlers); await started;
  const receipt = event(undefined, "early-event", "untrusted-conversation");
  receipt.event_type = "whatsapp.delivery_failed"; receipt.data.message.id = "early-send"; receipt.data.message.status = "failed";
  async function signed(e: any, valid = true) {
    const body = JSON.stringify(e), timestamp = String(Math.floor(Date.now() / 1000)), requestId = "early-request";
    return handleInkboxWebhook(body, { "x-inkbox-request-id": requestId, "x-inkbox-timestamp": timestamp,
      "x-inkbox-signature": valid ? "sha256=" + createHmac("sha256", "synthetic-key").update(`${requestId}.${timestamp}.${body}`).digest("hex") : "invalid" },
      { signingKey: "synthetic-key", handlers: b.handlers });
  }
  try {
    expect((await signed(receipt, false)).status).toBe(403);
    const beforeFile = (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!;
    expect(JSON.parse(await readFile(join(state.dir, beforeFile), "utf8")).whatsappObservations).toBeUndefined();
    const foreign = structuredClone(receipt); foreign.data.message.agent_identity_id = "another-identity";
    await expect(dispatchInbound(foreign, b.handlers)).rejects.toThrow("identity mismatch");
    expect((await signed(receipt)).status).toBe(200);
    expect((await signed(receipt)).status).toBe(200);
    const journalFile = (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!;
    const journal = JSON.parse(await readFile(join(state.dir, journalFile), "utf8"));
    expect(Object.values(journal.whatsappObservations ?? {})).toEqual([expect.objectContaining({ messageId: "early-send", identityId: f.identity.id })]);
    expect(Object.values(journal.whatsappObservations)[0]).not.toHaveProperty("conversationId");
    expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  } finally { release(); await settle(b); }
  lookup.mockResolvedValue("early-send");
  const recovered = f.bridge(); await settle(recovered);
  expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  const wrong = event(undefined, "other-turn", "untrusted-conversation"); wrong.data.message.id = "other-message";
  await dispatchInbound(wrong, recovered.handlers); await settle(recovered);
  expect(JSON.stringify(f.core.inbound.buildContext.mock.calls.at(-1)[0])).not.toContain("whatsapp.delivery_failed");
  const next = event(undefined, "next-turn"); next.data.message.id = "next-message";
  await dispatchInbound(next, recovered.handlers); await settle(recovered);
  expect(f.core.inbound.buildContext.mock.calls.at(-1)[0].message.bodyForAgent.match(/whatsapp.delivery_failed/g)).toHaveLength(1);
  await signed(receipt);
  const later = event(undefined, "later-turn"); later.data.message.id = "later-message";
  const restarted = f.bridge(); await dispatchInbound(later, restarted.handlers); await settle(restarted);
  expect(JSON.stringify(f.core.inbound.buildContext.mock.calls.at(-1)[0])).not.toContain("whatsapp.delivery_failed");
});

it("keeps legacy plain receipts without certainty evidence fenced on restart", async () => {
  const f = fixture(), deliver = vi.fn(async () => "must-not-send");
  const submit = vi.fn(async (input: any) => {
    await input.validateBeforeDispatch();
    await input.beforeToolSend("legacy-call", { idempotencyKey: "legacy-key", text: "Answer\n" });
    return ["Answer"];
  });
  const options: any = { accountId: "default", config: { identity: "example" }, runtime: f.runtime, submit, deliver };
  const first = createCompanionReceiver(options), incoming = event();
  incoming._openclawWhatsApp = true;
  incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000001" };
  incoming.data.message._ordinaryAddressed = true;
  await first.accept(incoming); await first.idle(); first.close();
  const path = join(state.dir, (await readdir(state.dir)).find((name) => name.startsWith("companion-") && name.endsWith(".json"))!);
  const journal = JSON.parse(await readFile(path, "utf8")), job: any = Object.values(journal.jobs)[0];
  delete job.toolSends["legacy-call"].whatsappUncertain;
  job.toolSends["legacy-call"].messageId = "legacy-accepted";
  job.outboundIds = ["legacy-accepted"]; job.state = "reply_pending";
  await writeFile(path, JSON.stringify(journal));
  const recovered = createCompanionReceiver(options); await recovered.recover(); await recovered.idle(); recovered.close();
  expect(submit).toHaveBeenCalledOnce(); expect(deliver).not.toHaveBeenCalled();
  expect(await recovered.whatsappDeliveryConversation("legacy-accepted")).toBe("00000000-0000-4000-8000-000000000001");
});

it.each(["pending", "access_required", "read-error"])("retains readiness %s across repeated polls and restart, then dispatches once", async (status) => {
  const f = fixture();
  if (status === "read-error") f.identity.getWhatsAppStatus.mockRejectedValue(new InkboxAPIError(403, "Unavailable"));
  else f.identity.getWhatsAppStatus.mockResolvedValue({ enabled: status === "pending", status });
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let bridge = f.bridge();
  try {
    const incoming = event();
    await dispatchInbound(incoming, bridge.handlers); await settle(bridge);
    for (let poll = 0; poll < 7; poll++) {
      const filename = (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!;
      const journal = JSON.parse(await readFile(join(state.dir, filename), "utf8"));
      const job: any = Object.values(journal.jobs)[0];
      expect(job.state).toBe("pending");
      expect(job.nativeComplete).not.toBe(true);
      expect(job.uncertaintyRecorded).not.toBe(true);
      expect(JSON.stringify(journal.context ?? {})).not.toContain("uncertain");
      expect(f.dispatchReply).not.toHaveBeenCalled();
      expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
      await bridge.shutdownA2A(); now += 31_000; bridge = f.bridge(); await settle(bridge);
    }
    f.identity.getWhatsAppStatus.mockResolvedValue({ enabled: true, status: "ready" });
    await bridge.shutdownA2A(); now += 31_000; bridge = f.bridge();
    await settle(bridge); await dispatchInbound(incoming, bridge.handlers); await settle(bridge);
    await bridge.shutdownA2A(); bridge = f.bridge(); await settle(bridge);
    expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    expect(f.identity.sendWhatsApp.mock.calls[0][0].replyToMessageId).toBe(incoming.data.message.id);
    expect(JSON.stringify(f.core.inbound.buildContext.mock.calls[0][0])).not.toContain("Prior turn outcome is uncertain");
  } finally { await bridge.shutdownA2A(); clock.mockRestore(); }
});

it("preflight bad UUID has zero send effect and cannot wedge the ordinary quoted final", async () => {
  const f = fixture(), bridge = f.bridge();
  let result: any, saved: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    result = await tools.get("inkbox_send_whatsapp").execute("bad-quote", { text: "Bad tool attempt", replyToMessageId: "not-a-uuid" });
    const filename = (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!;
    saved = Object.values(JSON.parse(await readFile(join(state.dir, filename), "utf8")).jobs)[0];
    await input.delivery.deliver({ text: "Ordinary final" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(result.isError).toBe(true); expect(saved.toolSends ?? {}).toEqual({});
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ text: "Ordinary final", replyToMessageId: event().data.message.id });
});

it.each([
  { to: "+15555550125" },
  { to: ["+1 (555) 555-0125", "+15555550124"], groupName: "Team" },
  { conversationId: "00000000-0000-4000-8000-000000000002" },
])("fences uncertain other-destination sends on the owning turn: %j", async (destination) => {
  const f = fixture(), bridge = f.bridge();
  f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup: async () => undefined } });
  let first: any, second: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    first = await send.execute("outreach-attempt", { ...destination, text: "Hello" });
    second = await send.execute("replacement-attempt", { ...destination, text: "Hello", idempotencyKey: "replacement-key" });
    await input.delivery.deliver({ text: "Hello again" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(first.isError).toBe(true);
  expect(second.details).toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  await bridge.shutdownA2A(); const restarted = f.bridge(); await settle(restarted);
  expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
});

it("uses distinct logical keys for intentional identical replies to the same quote", async () => {
  const f = fixture(), bridge = f.bridge();
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    await send.execute("intentional-first", { text: "Same reply" });
    await send.execute("intentional-second", { text: "Same reply" });
    return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
  const [first, second] = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(first.replyToMessageId).toBe(event().data.message.id); expect(second.replyToMessageId).toBe(first.replyToMessageId);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

it("keeps normalized rejected group retries on the original key and destination", async () => {
  const f = fixture(), bridge = f.bridge();
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(429, { error: "whatsapp_new_group_limit", retry_condition: "window_reset" }));
  f.identity.sendWhatsApp.mockResolvedValue({ id: "outreach-message", conversationId: "00000000-0000-4000-8000-000000000002", status: "queued" });
  let first: any, retry: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    first = await send.execute("group-attempt", { to: ["+1 (555) 555-0125", "+15555550124"], groupName: "Team", text: "Hello" });
    retry = await send.execute("group-attempt", { to: ["+15555550124", "+15555550125"], groupName: "Team", text: "Hello" });
    return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(first.details.requestAccepted).toBe(false); expect(retry.isError).not.toBe(true);
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
  const [original, retried] = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(retried).toEqual(original);
  // A lifecycle observation follows the outreach destination, not its owning turn.
  const observation = event(undefined, "outreach-status", event().data.message.conversation_id);
  observation.event_type = "whatsapp.delivered"; observation.data.message.id = "outreach-message";
  await dispatchInbound(observation, bridge.handlers); await settle(bridge);
  const next = event(undefined, "outreach-inbound", "00000000-0000-4000-8000-000000000002");
  next.data.message.id = "00000000-0000-4000-8000-000000000011";
  await dispatchInbound(next, bridge.handlers); await settle(bridge);
  expect(JSON.stringify(f.core.inbound.buildContext.mock.calls.at(-1)[0])).toContain("whatsapp.delivered");
});

it("keeps reaction dedup identities out of addressable message context", async () => {
  const f = fixture(), bridge = f.bridge(), incoming = event();
  incoming.event_type = "whatsapp.reaction_received"; incoming.data.message.direction = "outbound";
  incoming.data.reaction = { id: "00000000-0000-4000-8000-000000000012", target_message_id: incoming.data.message.id,
    conversation_id: incoming.data.message.conversation_id, agent_identity_id: f.identity.id, direction: "inbound",
    remote_number: "+15555550123", emoji: "👀", status: "applied", revision: 1 };
  await dispatchInbound(incoming, bridge.handlers); await settle(bridge);
  const body = f.core.inbound.buildContext.mock.calls[0][0].message.bodyForAgent;
  expect(body).toContain(`"id":"${incoming.data.message.id}"`);
  expect(body).not.toContain(`reaction:${incoming.data.reaction.id}`);
  const duplicate = structuredClone(incoming); duplicate.id = "redelivery-new-event";
  await dispatchInbound(duplicate, bridge.handlers); await settle(bridge);
  expect(f.dispatchReply).toHaveBeenCalledOnce();
});


it.each([
  { originalMedia: undefined, changedMedia: [], legacy: false },
  { originalMedia: [], changedMedia: undefined, legacy: false },
  { originalMedia: undefined, changedMedia: [], legacy: true },
  { originalMedia: [], changedMedia: undefined, legacy: true },
])("preserves rejected media field presence on exact replay (%j)", async ({ originalMedia, changedMedia, legacy }) => {
  const f = fixture(), bridge = f.bridge();
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(429, { error: "whatsapp_daily_limit_exceeded", retry_condition: "window_reset" }));
  let first: any, changed: any, retry: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    const original = { text: "Saved answer", ...(originalMedia !== undefined ? { mediaIds: originalMedia } : {}), ...(legacy ? { idempotencyKey: "retained-plain-key" } : {}) };
    first = await send.execute("original-attempt", original);
    const key = first.details.idempotencyKey;
    const quote = legacy ? {} : { replyToMessageId: event().data.message.id };
    changed = await send.execute("changed-attempt", { text: "Saved answer", idempotencyKey: key, ...quote, ...(changedMedia !== undefined ? { mediaIds: changedMedia } : {}) });
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    retry = await send.execute("exact-retry", { ...original, idempotencyKey: key, ...quote });
    return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(first.details.requestAccepted).toBe(false);
  expect(changed.isError).toBe(true);
  expect(changed.details.idempotencyKey).toBe(first.details.idempotencyKey);
  expect(retry.isError).not.toBe(true);
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
  const [original, retried] = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(retried).toEqual(original);
  expect(original.replyToMessageId).toBe(legacy ? undefined : event().data.message.id);
  expect(original.mediaIds).toEqual(originalMedia);
});

it.each([
  { to: "+15555550125" },
  { to: ["+15555550125", "+15555550124"], groupName: "Team" },
].flatMap(destination => ["ready", "unavailable", "foreign-owner", "wrong-message", "inbound", "missing-route", "identity-changed", "archived"].map(readState => ({ destination, readState }))))(
  "recovers lost-response outreach context only through its owned destination across restart (%j)",
  async ({ destination, readState }) => {
    const f = fixture(), destinationId = "00000000-0000-4000-8000-000000000002";
    let bridge = f.bridge(), release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const lookup = vi.fn(async () => "outreach-lost");
    f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
    let currentRead = readState;
    const ownedMessage = { id: "outreach-lost", agentIdentityId: f.identity.id, direction: "outbound", conversationId: destinationId };
    f.identity.getWhatsAppMessage = vi.fn(async () => {
      if (currentRead === "unavailable") throw new TypeError("read unavailable");
      if (currentRead === "identity-changed") f.runtime.getIdentity = async () => ({ ...f.identity, id: "changed-identity" });
      return { ...ownedMessage,
        ...(currentRead === "foreign-owner" ? { agentIdentityId: "another-identity" } : {}),
        ...(currentRead === "wrong-message" ? { id: "another-message" } : {}),
        ...(currentRead === "inbound" ? { direction: "inbound" } : {}),
        ...(currentRead === "missing-route" ? { conversationId: "" } : {}) };
    });
    f.identity.sendWhatsApp.mockImplementationOnce(async () => { entered(); await held; throw new TypeError("response lost"); });
    f.dispatchReply.mockImplementation(async () => ({ dispatched: true }));
    let first: any, replacement: any;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      const tools = new Map<string, any>();
      registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
      const send = tools.get("inkbox_send_whatsapp");
      first = await send.execute("outreach-attempt", { ...destination, text: "Hello", idempotencyKey: "outreach-key" });
      replacement = await send.execute("replacement", { ...destination, text: "Hello again", idempotencyKey: "replacement-key" });
      await input.delivery.deliver({ text: "Hello again" }, { kind: "final" });
      return { dispatched: true };
    });
    await dispatchInbound(event(), bridge.handlers); await started;
    const receipt = event(undefined, "early-outreach-failure", "callback-route");
    receipt.event_type = "whatsapp.delivery_failed"; receipt.data.message.id = ownedMessage.id; receipt.data.message.status = "failed";
    const signed = async () => {
      const body = JSON.stringify(receipt), timestamp = String(Math.floor(Date.now() / 1000)), requestId = "outreach-request";
      return handleInkboxWebhook(body, { "x-inkbox-request-id": requestId, "x-inkbox-timestamp": timestamp,
        "x-inkbox-signature": "sha256=" + createHmac("sha256", "synthetic-key").update(`${requestId}.${timestamp}.${body}`).digest("hex") },
      { signingKey: "synthetic-key", handlers: bridge.handlers });
    };
    const journal = async () => {
      const name = (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!;
      return JSON.parse(await readFile(join(state.dir, name), "utf8"));
    };
    try {
      expect((await signed()).status).toBe(200);
      expect(Object.values((await journal()).whatsappObservations)[0]).not.toHaveProperty("conversationId");
    } finally { release(); await settle(bridge); }
    expect(first.isError).toBe(true);
    expect(replacement.details).toMatchObject({ sendAttempted: false, idempotencyKey: "outreach-key" });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith({ senderKind: "whatsapp_identity", senderId: f.identity.id, operation: "whatsapp.send", idempotencyKey: "outreach-key" });
    expect(f.identity.getWhatsAppMessage).toHaveBeenCalledWith(ownedMessage.id);
    if (readState === "archived") {
      await bridge.shutdownA2A();
      const name = (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!;
      const path = join(state.dir, name), saved = await journal();
      const receiptId = createHash("sha256").update(`${f.identity.id}:${event().id}`).digest("hex");
      const receiptPath = join(`${path}.receipts`, "events", `${receiptId}.json`);
      const archived = JSON.parse(await readFile(receiptPath, "utf8"));
      delete archived.job.toolSends["outreach-attempt"].whatsappConversationId;
      for (const observation of Object.values(saved.whatsappObservations) as any[]) delete observation.conversationId;
      await writeFile(receiptPath, JSON.stringify(archived)); await writeFile(path, JSON.stringify(saved));
      currentRead = "unavailable"; bridge = f.bridge(); await settle(bridge);
      expect(Object.values((await journal()).whatsappObservations)[0]).not.toHaveProperty("conversationId");
      expect((await journal()).jobs).toEqual({});
    } else if (readState !== "ready") {
      const saved = await journal(), job: any = Object.values(saved.jobs)[0];
      expect(job.toolSends["outreach-attempt"]).toMatchObject({ messageId: ownedMessage.id, whatsappUncertain: true });
      expect(job.toolSends["outreach-attempt"]).not.toHaveProperty("whatsappConversationId");
      expect(Object.values(saved.whatsappObservations)[0]).not.toHaveProperty("conversationId");
      await bridge.shutdownA2A(); bridge = f.bridge();
      f.runtime.getIdentity = async () => f.identity;
      // Repeated unavailable route reads must not exhaust the message-key lookup budget.
      if (readState === "identity-changed") currentRead = "unavailable";
      for (let poll = 0; poll < 6; poll++) await settle(bridge);
      expect(Object.values((await journal()).whatsappObservations)[0]).not.toHaveProperty("conversationId");
      expect(lookup).toHaveBeenCalledOnce();
    }
    currentRead = "ready"; f.runtime.getIdentity = async () => f.identity;
    await bridge.shutdownA2A(); bridge = f.bridge(); await settle(bridge);
    expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    expect(Object.values((await journal()).whatsappObservations)[0]).toMatchObject({ conversationId: destinationId });
    const turns = async (id: string, conversationId: string) => {
      const incoming = event(undefined, id, conversationId); incoming.data.message.id = `${id}-message`;
      await dispatchInbound(incoming, bridge.handlers); await settle(bridge);
      return f.core.inbound.buildContext.mock.calls.at(-1)[0].message.bodyForAgent;
    };
    expect(await turns("source-next", event().data.message.conversation_id)).not.toContain("whatsapp.delivery_failed");
    expect(await turns("callback-next", "callback-route")).not.toContain("whatsapp.delivery_failed");
    expect((await turns("destination-next", destinationId)).match(/whatsapp.delivery_failed/g)).toHaveLength(1);
    await bridge.shutdownA2A(); bridge = f.bridge(); await settle(bridge);
    expect((await signed()).status).toBe(200);
    expect(await turns("destination-later", destinationId)).not.toContain("whatsapp.delivery_failed");
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalledOnce();
    await bridge.shutdownA2A();
  },
);

const independentOutreachCases = [
  { original: { to: "+15555550124" }, alias: { to: ["+1 (555) 555-0124"] }, independent: { to: "+15555550125" } },
  { original: { to: ["+15555550124", "+15555550125"], groupName: "Team" }, alias: { to: ["+1 (555) 555-0125", "+15555550124"], groupName: "Team" }, independent: { to: ["+15555550124", "+15555550126"], groupName: "Team" } },
  { original: { conversationId: "00000000-0000-4000-8000-000000000002" }, alias: { conversationId: "00000000-0000-4000-8000-000000000002" }, independent: { conversationId: "00000000-0000-4000-8000-000000000003" } },
];
async function currentWhatsAppJob() {
  const filename = (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!;
  return Object.values(JSON.parse(await readFile(join(state.dir, filename), "utf8")).jobs)[0] as any;
}

it.each(independentOutreachCases.flatMap(destinations => [false, true].map(retryOriginal => ({ ...destinations, retryOriginal }))))(
  "retains a definitive outreach rejection while independent outreach and the source final proceed (%j)",
  async ({ original, alias, independent, retryOriginal }) => {
    const f = fixture(), bridge = f.bridge();
    f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(429, { error: "whatsapp_new_group_limit", retry_condition: "window_reset" }));
    let first: any, later: any, repeated: any, retried: any, retained: any, afterLater: any;
    const refused: any[] = [];
    let caught: unknown;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        first = await send.execute("original-outreach", { ...original, text: "Hello" });
        retained = (await currentWhatsAppJob()).toolSends["original-outreach"];
        later = await send.execute("independent-outreach", { ...independent, text: "Hello" });
        afterLater = (await currentWhatsAppJob()).toolSends["original-outreach"];
        // Repeating identical content is a new logical request when the host call differs.
        repeated = await send.execute("intentional-later-outreach", { ...independent, text: "Hello" });
        refused.push(await send.execute("changed-original", { ...alias, text: "Changed" }));
        refused.push(await send.execute("new-key-original", { ...alias, text: "Hello", idempotencyKey: "replacement-key" }));
        refused.push(await send.execute("key-reused-elsewhere", { ...independent, text: "Hello", idempotencyKey: first.details.idempotencyKey }));
        refused.push(await send.execute("original-outreach", { ...independent, text: "Hello" }));
        expect((await currentWhatsAppJob()).toolSends["original-outreach"]).toEqual(retained);
        if (retryOriginal) retried = await send.execute("retained-exact-retry", { ...alias, text: "Hello", idempotencyKey: first.details.idempotencyKey });
        await input.delivery.deliver({ text: "Ordinary source final" }, { kind: "final" });
      } catch (error) { caught = error; throw error; }
      return { dispatched: true };
    });
    await dispatchInbound(event(), bridge.handlers); await settle(bridge);
    expect(caught).toBeUndefined();
    expect(first.details.requestAccepted).toBe(false);
    expect(later.isError).not.toBe(true); expect(repeated.isError).not.toBe(true);
    expect(afterLater).toEqual(retained);
    for (const result of refused) expect(result.details).toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
    const requests = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
    expect(requests).toHaveLength(retryOriginal ? 5 : 4);
    expect(requests[1].idempotencyKey).not.toBe(requests[0].idempotencyKey);
    expect(requests[2].idempotencyKey).not.toBe(requests[1].idempotencyKey);
    if (retryOriginal) { expect(retried.isError).not.toBe(true); expect(requests[3]).toEqual(requests[0]); }
    expect(requests.at(-1)).toMatchObject({ conversationId: event().data.message.conversation_id, replyToMessageId: event().data.message.id, text: "Ordinary source final" });
    await bridge.shutdownA2A(); const restarted = f.bridge(); await settle(restarted);
    expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(requests.length);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    if (!retryOriginal) expect((await currentWhatsAppJob()).toolSends["original-outreach"]).toEqual(retained);
    await restarted.shutdownA2A();
  },
);

it.each(["lost-response", "uncertain-response", "sending", "retry-lost-response"])(
  "keeps independent outreach and the source final fenced during %s", async (outcome) => {
    const f = fixture(), bridge = f.bridge();
    f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup: async () => undefined } });
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    if (outcome === "retry-lost-response") f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(403, { error: "whatsapp_contact_not_allowed" }));
    f.identity.sendWhatsApp.mockImplementationOnce(async () => {
      entered();
      if (outcome === "sending") await held;
      if (outcome === "uncertain-response") return { id: "uncertain-outreach", conversationId: "00000000-0000-4000-8000-000000000002", status: "uncertain" };
      throw new TypeError("response lost");
    });
    let second: any;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      const tools = new Map<string, any>();
      registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
      const send = tools.get("inkbox_send_whatsapp");
      const request = { to: "+15555550124", text: "Hello" };
      const rejected = outcome === "retry-lost-response" ? await send.execute("rejected-outreach", request) : undefined;
      const pending = send.execute("uncertain-outreach", { ...request, ...(rejected ? { idempotencyKey: rejected.details.idempotencyKey } : {}) });
      if (outcome === "sending") await started; else await pending;
      second = await send.execute("independent-outreach", { to: "+15555550125", text: "Hello" });
      release(); await pending;
      await input.delivery.deliver({ text: "Ordinary source final" }, { kind: "final" });
      return { dispatched: true };
    });
    await dispatchInbound(event(), bridge.handlers); await settle(bridge);
    expect(second.details.sendAttempted).toBe(false);
    expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(outcome === "retry-lost-response" ? 2 : 1);
    await bridge.shutdownA2A(); const restarted = f.bridge(); await settle(restarted);
    expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(outcome === "retry-lost-response" ? 2 : 1);
    expect(f.dispatchReply).toHaveBeenCalledOnce(); await restarted.shutdownA2A();
  },
);

it("retains each rejected destination when later outreach is also rejected", async () => {
  const f = fixture(), bridge = f.bridge();
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(403, { error: "whatsapp_contact_not_allowed" }));
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(429, { error: "whatsapp_new_contact_rate_limited" }));
  let first: any, second: any, retryFirst: any, retrySecond: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    first = await send.execute("bob", { to: "+15555550124", text: "Hello" });
    second = await send.execute("carol", { to: "+15555550125", text: "Hello" });
    retrySecond = await send.execute("carol-retry", { to: "+15555550125", text: "Hello", idempotencyKey: second.details.idempotencyKey });
    retryFirst = await send.execute("bob-retry", { to: "+15555550124", text: "Hello", idempotencyKey: first.details.idempotencyKey });
    await input.delivery.deliver({ text: "Ordinary source final" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(first.details.requestAccepted).toBe(false); expect(second.details.requestAccepted).toBe(false);
  expect(retryFirst.isError).not.toBe(true); expect(retrySecond.isError).not.toBe(true);
  const requests = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(requests).toHaveLength(5); expect(requests[2]).toEqual(requests[1]); expect(requests[3]).toEqual(requests[0]);
  expect(requests[4]).toMatchObject({ text: "Ordinary source final", replyToMessageId: event().data.message.id });
  await bridge.shutdownA2A();
});

it("keeps a retained exact retry fenced by later independent uncertainty without losing the rejection", async () => {
  const f = fixture(), bridge = f.bridge();
  f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup: async () => undefined } });
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(403, { error: "whatsapp_contact_not_allowed" }));
  f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  let retained: any, after: any, retry: any, later: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    const first = await send.execute("bob", { to: "+15555550124", text: "Hello" });
    retained = (await currentWhatsAppJob()).toolSends.bob;
    later = await send.execute("carol", { to: "+15555550125", text: "Hello" });
    retry = await send.execute("bob-retry", { to: "+15555550124", text: "Hello", idempotencyKey: first.details.idempotencyKey });
    after = (await currentWhatsAppJob()).toolSends.bob;
    await input.delivery.deliver({ text: "Ordinary source final" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(after).toEqual(retained);
  expect(retry.details).toMatchObject({ sendAttempted: false, idempotencyKey: later.details.idempotencyKey });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
  await bridge.shutdownA2A(); const restarted = f.bridge(); await settle(restarted);
  expect((await currentWhatsAppJob()).toolSends.bob).toEqual(retained);
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2); await restarted.shutdownA2A();
});

it.each([false, true].flatMap(sourceRejected => [false, true].map(found => ({ sourceRejected, found }))))(
  "retains mixed rejection and uncertain sibling context across restart (%j)", async ({ sourceRejected, found }) => {
    const f = fixture(), destinationId = "00000000-0000-4000-8000-000000000002";
    let restarted = false, rejected: any, submitError: unknown;
    const lookup = vi.fn(async () => restarted && found ? "accepted-carol" : undefined);
    f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup } });
    f.identity.getWhatsAppMessage = vi.fn(async () => ({
      id: "accepted-carol", agentIdentityId: f.identity.id, direction: "outbound", conversationId: destinationId,
    }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(sourceRejected ? 409 : 403, {
      error: sourceRejected ? "whatsapp_quote_unavailable" : "whatsapp_contact_not_allowed",
    }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
    const deliver = vi.fn(async () => "must-not-send");
    const submit = vi.fn(async (_input: any): Promise<string[]> => []);
    submit.mockImplementationOnce(async (input: any) => {
      await input.validateBeforeDispatch();
      const release = bindNativeSource("mixed-source", {
        whatsapp: true, sourceMessageId: input.messageId, identityId: f.identity.id,
        conversationId: input.reply.conversationId, replyToMessageId: event().data.message.id, author: input.author, closed: false,
        validate: input.validateBeforeDispatch, beforeSend: input.beforeToolSend,
        afterSend: input.afterToolSend, rejectSend: input.rejectToolSend,
      });
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: "mixed-source" }) : def; tools.set(tool.name, tool); } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        const first = await send.execute("bob", { ...(sourceRejected ? {} : { to: "+15555550124" }), text: "Hello", idempotencyKey: "rejected-bob-key" });
        expect(first.details.requestAccepted).toBe(false);
        rejected = (await currentWhatsAppJob()).toolSends.bob;
        await send.execute("carol", { to: "+15555550125", text: "Hello", idempotencyKey: "original-carol-key" });
        return ["Ordinary source final"];
      } catch (error) { submitError = error; throw error; }
      finally { release(); }
    });
    const options = { accountId: "default", config: { identity: "example" }, runtime: f.runtime, submit, deliver };
    // Stop at the durable pause, before an in-process recovery records context.
    let receiver = createCompanionReceiver({ ...options, activity: (_event, phase) => { if (phase === "failed") receiver.close(); } });
    const incoming = event();
    incoming._openclawWhatsApp = true;
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: incoming.data.message.conversation_id, conversation_id: incoming.data.message.conversation_id };
    incoming.data.message._ordinaryAddressed = true;
    try {
      await receiver.accept(incoming); await receiver.idle();
      expect(submitError).toBeUndefined();
      expect(await currentWhatsAppJob()).toMatchObject({ state: "paused", replyNotAttempted: true, replies: ["Ordinary source final"] });
      expect((await currentWhatsAppJob()).uncertaintyRecorded).not.toBe(true);
      expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
      restarted = true; receiver = createCompanionReceiver(options); await receiver.recover(); await receiver.idle();
      const saved = await currentWhatsAppJob();
      expect(saved.toolSends.bob).toEqual(rejected);
      expect(saved.toolSends.carol).toMatchObject({ whatsappKey: "original-carol-key", whatsappUncertain: true, whatsappDestination: { to: ["+15555550125"] } });
      if (found) {
        expect(saved.toolSends.carol).toMatchObject({ messageId: "accepted-carol", whatsappConversationId: destinationId });
        expect(await receiver.whatsappDeliveryConversation("accepted-carol")).toBe(destinationId);
        expect(f.identity.getWhatsAppMessage).toHaveBeenCalledWith("accepted-carol");
      } else expect(saved.toolSends.carol.messageId).toBeUndefined();
      expect(lookup).toHaveBeenCalledWith({ senderKind: "whatsapp_identity", senderId: f.identity.id, operation: "whatsapp.send", idempotencyKey: "original-carol-key" });
      expect(lookup.mock.calls.every(([request]: any) => request.idempotencyKey === "original-carol-key")).toBe(true);
      expect(submit).toHaveBeenCalledOnce();
      const next = structuredClone(incoming); next.id = "next-inbound"; next.data.message.id = "next-inbound-message"; next.companion.sequence = 2;
      await receiver.accept(next); await receiver.idle();
      const context = submit.mock.calls.at(-1)![0].body;
      expect(context).toContain("uncertain");
      expect(context).toContain("original-carol-key");
      expect(context).toContain("Do not repeat prior actions or sends");
      expect(context).not.toContain("Prior WhatsApp request was rejected/not accepted");
      expect(context).not.toContain("rejected-bob-key");
      expect(saved.state).toBe(found && !sourceRejected ? "done" : "paused");
      expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
      expect(deliver).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(2);
    } finally { receiver.close(); await receiver.idle(); }
  },
);

it("never replaces a rejected source quote with a new-key plain send or an automatic final", async () => {
  const f = fixture(), bridge = f.bridge();
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
  let first: any, plain: any;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    first = await send.execute("source-quote", { text: "Answer" });
    plain = await send.execute("plain-replacement", { text: "Answer", idempotencyKey: "new-plain-key" });
    await input.delivery.deliver({ text: "Ordinary source final" }, { kind: "final" }); return { dispatched: true };
  });
  await dispatchInbound(event(), bridge.handlers); await settle(bridge);
  expect(first.details.requestAccepted).toBe(false);
  expect(plain.details).toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(f.identity.sendWhatsApp.mock.calls[0][0].replyToMessageId).toBe(event().data.message.id);
  await bridge.shutdownA2A(); const restarted = f.bridge(); await settle(restarted);
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce(); await restarted.shutdownA2A();
});

const aliasConversation = "abcdefab-0000-4000-8000-000000000002";
const aliasQuote = "abcdefab-0000-4000-8000-000000000009";
it.each([false, true].flatMap(group => [undefined, [], ["00000000-0000-4000-8000-000000000004"]].flatMap(mediaIds =>
  [false, true].map(retry => ({ group, mediaIds, retry })))))(
  "retains a rejected source while allowing independent destinations (%j)", async ({ group, mediaIds, retry }) => {
    const f = fixture(), bridge = f.bridge();
    const incoming = event(f.identity.id, "source-rejection", aliasConversation);
    const members = ["+15555550123", "+15555550124"];
    incoming.data.message.is_group = group;
    incoming.data.message.participants = group ? members : members.slice(0, 1);
    const otherGroup = "abcdefab-0000-4000-8000-000000000003";
    const carol = "abcdefab-0000-4000-8000-000000000004";
    f.identity.getWhatsAppConversation.mockImplementation(async (id: string) => ({ id: id.toLowerCase(), agentIdentityId: f.identity.id,
      isGroup: id.toLowerCase() === otherGroup || (id.toLowerCase() === aliasConversation && group),
      participants: id.toLowerCase() === carol ? ["+15555550125"] : id.toLowerCase() === otherGroup || group ? members : members.slice(0, 1), unresolvedParticipantCount: 0 }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
    const payload = { text: " Answer\n", ...(mediaIds !== undefined ? { mediaIds } : {}) };
    let caught: unknown, saved: any;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        const first = await send.execute("source-rejected", payload);
        expect(first.details.requestAccepted).toBe(false);
        saved = (await currentWhatsAppJob()).toolSends["source-rejected"];
        for (const [index, destination] of [
          { to: "+15555550125" }, { conversationId: carol }, { conversationId: otherGroup },
          { to: members, groupName: "Team" }, ...(group ? [{ to: members[0] }] : []),
        ].entries()) {
          expect((await send.execute(`independent-${index}`, { ...destination, text: "Hello" })).isError).not.toBe(true);
          expect((await currentWhatsAppJob()).toolSends["source-rejected"]).toEqual(saved);
        }
        const aliases = [{}, { conversationId: aliasConversation }, { conversationId: aliasConversation.toUpperCase() },
          ...(!group ? [{ to: "+15555550123" }, { to: [" +1 (555) 555-0123 "] }] : [])];
        for (const [index, destination] of aliases.entries()) {
          const blocked = await send.execute(`replacement-${index}`, { ...destination, ...payload, idempotencyKey: `replacement-${index}` });
          expect(blocked.details).toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
        }
        for (const changed of [
          { ...payload, text: "Answer" },
          { text: payload.text, ...(mediaIds === undefined ? { mediaIds: [] } : {}) },
          { ...payload, replyToMessageId: aliasQuote },
          { ...payload, to: "+15555550125" },
        ]) {
          expect((await send.execute("changed-retry", { ...changed, idempotencyKey: first.details.idempotencyKey })).details)
            .toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
        }
        expect((await send.execute("source-rejected", { to: "+15555550125", text: "Hello" })).details.sendAttempted).toBe(false);
        expect((await currentWhatsAppJob()).toolSends["source-rejected"]).toEqual(saved);
        if (retry) {
          expect((await send.execute("exact-source-retry", { ...payload, idempotencyKey: first.details.idempotencyKey })).isError).not.toBe(true);
          expect(f.identity.sendWhatsApp.mock.calls.at(-1)[0]).toEqual(f.identity.sendWhatsApp.mock.calls[0][0]);
        }
        await input.delivery.deliver({ text: "Plain automatic final" }, { kind: "final" });
      } catch (error) { caught = error; }
      return { dispatched: true };
    });
    try {
      await dispatchInbound(incoming, bridge.handlers); await settle(bridge); expect(caught).toBeUndefined();
      const requests = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
      expect(requests).toHaveLength(5 + Number(group) + Number(retry));
      expect(requests[0]).toMatchObject({ conversationId: aliasConversation, replyToMessageId: incoming.data.message.id, ...payload });
      expect(Object.hasOwn(requests[0], "mediaIds")).toBe(mediaIds !== undefined);
      expect(requests[3].conversationId).toBe(otherGroup);
      expect(requests[4]).toMatchObject({ to: members, groupName: "Team" }); expect(requests[4]).not.toHaveProperty("conversationId");
      expect(requests.some((request: any) => request.text === "Plain automatic final")).toBe(false);
      await bridge.shutdownA2A(); const restarted = f.bridge();
      try {
        await settle(restarted); expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(requests.length);
        expect(f.dispatchReply).toHaveBeenCalledOnce();
        if (!retry) expect((await currentWhatsAppJob()).toolSends["source-rejected"]).toEqual(saved);
      } finally { await restarted.shutdownA2A(); }
    } finally { await bridge.shutdownA2A(); }
  },
);

it.each(["source-lost", "source-uncertain", "outreach-lost", "outreach-uncertain", "outreach-sending"])(
  "keeps additional effects fenced by %s after a source attempt", async (outcome) => {
    const f = fixture(), bridge = f.bridge();
    f.runtime.getClient = async () => ({ contacts: { lookup: async () => [] }, messageSends: { lookup: async () => undefined } });
    const sourceRejected = outcome.startsWith("outreach");
    if (sourceRejected) f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.identity.sendWhatsApp.mockImplementationOnce(async () => {
      entered(); if (outcome.endsWith("sending")) await held;
      if (outcome.endsWith("uncertain")) return { id: "uncertain-message", conversationId: event().data.message.conversation_id, status: "uncertain" };
      throw new TypeError("response lost");
    });
    let caught: unknown, saved: any;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        const first = await send.execute("source-attempt", { text: "Answer" });
        saved = (await currentWhatsAppJob()).toolSends["source-attempt"];
        let pending: Promise<any> | undefined;
        if (sourceRejected) {
          expect(first.details.requestAccepted).toBe(false);
          pending = send.execute("uncertain-outreach", { to: "+15555550125", text: "Hello" });
          if (outcome.endsWith("sending")) await started; else await pending;
        }
        for (const destination of [{ to: "+15555550126" }, { conversationId: aliasConversation }, { to: ["+15555550124", "+15555550126"], groupName: "Team" }]) {
          expect((await send.execute("additional-effect", { ...destination, text: "Hello" })).details.sendAttempted).toBe(false);
        }
        if (sourceRejected) expect((await send.execute("exact-source-retry", { text: "Answer", idempotencyKey: first.details.idempotencyKey })).details.sendAttempted).toBe(false);
        expect((await currentWhatsAppJob()).toolSends["source-attempt"]).toEqual(saved);
        release(); await pending;
        await input.delivery.deliver({ text: "Plain automatic final" }, { kind: "final" });
      } catch (error) { caught = error; } finally { release(); }
      return { dispatched: true };
    });
    try {
      await dispatchInbound(event(), bridge.handlers); await settle(bridge); expect(caught).toBeUndefined();
      expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(sourceRejected ? 2 : 1);
      await bridge.shutdownA2A(); const restarted = f.bridge();
      try {
        await settle(restarted); expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(sourceRejected ? 2 : 1);
        if (sourceRejected) expect((await currentWhatsAppJob()).toolSends["source-attempt"]).toEqual(saved);
      } finally { await restarted.shutdownA2A(); }
    } finally { await bridge.shutdownA2A(); }
  },
);

const destinationAliasCases = [
  { name: "conversation to phone", original: { conversationId: aliasConversation, replyToMessageId: aliasQuote }, replacement: { to: "+15555550124" } },
  { name: "phone to conversation", original: { to: "+15555550124" }, replacement: { conversationId: aliasConversation } },
  { name: "UUID case", original: { conversationId: aliasConversation.toUpperCase(), replyToMessageId: aliasQuote }, replacement: { conversationId: aliasConversation } },
];
it.each([false, true])("matches a saved source rejection using verified direct metadata after restart (legacy=%s)", async (legacy) => {
  const f = fixture(); let bridge = f.bridge();
  // Use the owned conversation's phone, not the inbound author, for this alias.
  f.identity.getWhatsAppConversation.mockImplementation(async (id: string) => ({ id: id.toLowerCase(), agentIdentityId: f.identity.id,
    isGroup: false, participants: ["+15555550124"], unresolvedParticipantCount: 0 }));
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
  const payload = { text: " Answer\n", mediaIds: [] };
  let caught: unknown, saved: any;
  const exercise = async (input: any, first: boolean) => {
    const tools = new Map<string, any>();
    registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
    const send = tools.get("inkbox_send_whatsapp");
    if (first) {
      expect((await send.execute("saved-source", payload)).details.requestAccepted).toBe(false);
      saved = (await currentWhatsAppJob()).toolSends["saved-source"];
      expect(saved.whatsappReplyToMessageId).toBe(event().data.message.id);
      expect(saved.whatsappDestinationEvidence).toMatchObject({ identityId: f.identity.id, conversationId: aliasConversation, directRecipient: "+15555550124" });
      return;
    }
    expect((await send.execute("carol", { to: "+15555550125", text: "Hello" })).isError).not.toBe(true);
    for (const to of ["+15555550124", ["+1 (555) 555-0124"]]) {
      expect((await send.execute("source-phone-alias", { to, text: payload.text, idempotencyKey: "plain-alias-key" })).details)
        .toMatchObject({ sendAttempted: false, idempotencyKey: saved.whatsappKey });
    }
    expect((await currentWhatsAppJob()).toolSends["saved-source"]).toEqual(saved);
    expect((await send.execute("exact-source", { ...payload, idempotencyKey: saved.whatsappKey })).isError).not.toBe(true);
    expect(f.identity.sendWhatsApp.mock.calls.at(-1)[0]).toEqual(f.identity.sendWhatsApp.mock.calls[0][0]);
    await input.delivery.deliver({ text: "Plain automatic final" }, { kind: "final" });
  };
  f.dispatchReply.mockImplementationOnce(async (input: any) => { try { await exercise(input, true); } catch (error) { caught = error; } return { dispatched: true }; });
  try {
    await dispatchInbound(event(f.identity.id, "source-restart", aliasConversation), bridge.handlers); await settle(bridge);
    expect(caught).toBeUndefined();
    await bridge.shutdownA2A(); bridge = f.bridge(); await settle(bridge);
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce(); expect(f.dispatchReply).toHaveBeenCalledOnce();
    await bridge.shutdownA2A();
    const path = join(state.dir, (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!);
    const journal = JSON.parse(await readFile(path, "utf8")), job: any = Object.values(journal.jobs)[0];
    // Explicit resume must recover the fence and retry from durable state alone.
    job.state = "pending"; job.nativeComplete = false;
    if (legacy) delete job.toolSends["saved-source"].whatsappDestinationEvidence;
    await writeFile(path, JSON.stringify(journal));
    f.dispatchReply.mockImplementationOnce(async (input: any) => { try { await exercise(input, false); } catch (error) { caught = error; } return { dispatched: true }; });
    bridge = f.bridge(); await settle(bridge);
    expect(caught).toBeUndefined(); expect(f.dispatchReply).toHaveBeenCalledTimes(2); expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(3);
  } finally { await bridge.shutdownA2A(); }
});

it.each([{ to: "+15555550124" }, { conversationId: aliasConversation.toUpperCase(), replyToMessageId: aliasQuote }])(
  "recognizes the bound source as an alias of a rejected explicit destination (%j)", async (destination) => {
    const f = fixture(), bridge = f.bridge();
    f.identity.getWhatsAppConversation.mockImplementation(async (id: string) => ({ id: id.toLowerCase(), agentIdentityId: f.identity.id,
      isGroup: false, participants: ["+15555550124"], unresolvedParticipantCount: 0 }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
    let caught: unknown;
    f.dispatchReply.mockImplementationOnce(async (input: any) => {
      try {
        const tools = new Map<string, any>();
        registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
        const send = tools.get("inkbox_send_whatsapp");
        const first = await send.execute("explicit-source-alias", { ...destination, text: "Answer" });
        expect(first.details.requestAccepted).toBe(false);
        expect((await send.execute("bound-source-replacement", { text: "Answer", idempotencyKey: "new-source-key" })).details)
          .toMatchObject({ sendAttempted: false, idempotencyKey: first.details.idempotencyKey });
      } catch (error) { caught = error; }
      return { dispatched: true };
    });
    try {
      await dispatchInbound(event(f.identity.id, "source-alias", aliasConversation), bridge.handlers); await settle(bridge);
      expect(caught).toBeUndefined(); expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
    } finally { await bridge.shutdownA2A(); }
  },
);

it.each(destinationAliasCases.flatMap(test => [false, true, "legacy"].map(restart => ({ ...test, restart }))))(
  "retains destination identity for $name (restart=$restart)", async ({ original, replacement, restart }) => {
    const f = fixture(); let bridge = f.bridge();
    f.identity.getWhatsAppConversation.mockImplementation(async (id: string) => ({ id: id.toLowerCase(), agentIdentityId: f.identity.id, isGroup: false,
      participants: [id.toLowerCase() === aliasConversation ? "+15555550124" : "+15555550123"], unresolvedParticipantCount: 0 }));
    f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
    const payload = { ...original, text: "Answer\n", mediaIds: [], idempotencyKey: "original-alias-key" };
    let caught: unknown, saved: any;
    const exercise = async (input: any, first: boolean) => {
      const tools = new Map<string, any>();
      registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
      const send = tools.get("inkbox_send_whatsapp");
      if (first) {
        expect((await send.execute("original-alias", payload)).details.requestAccepted).toBe(false);
        saved = (await currentWhatsAppJob()).toolSends["original-alias"];
      }
      if (restart && first) return;
      for (const changed of [
        { ...replacement, text: payload.text, mediaIds: [], idempotencyKey: "replacement-alias-key" },
        { ...replacement, text: "Changed", idempotencyKey: "another-alias-key" },
        { ...replacement, text: payload.text, mediaIds: [], idempotencyKey: payload.idempotencyKey },
      ]) {
        const result = await send.execute("replacement-alias", changed);
        expect(result.details).toMatchObject({ sendAttempted: false, idempotencyKey: payload.idempotencyKey });
      }
      expect((await currentWhatsAppJob()).toolSends["original-alias"]).toEqual(saved);
      expect((await send.execute("independent-alias", { to: "+15555550125", text: payload.text })).isError).not.toBe(true);
      expect((await send.execute("exact-alias", payload)).isError).not.toBe(true);
      expect(f.identity.sendWhatsApp.mock.calls.at(-1)[0]).toEqual(f.identity.sendWhatsApp.mock.calls[0][0]);
    };
    f.dispatchReply.mockImplementationOnce(async (input: any) => { try { await exercise(input, true); } catch (error) { caught = error; } return { dispatched: true }; });
    try {
      await dispatchInbound(event(), bridge.handlers); await settle(bridge);
      expect(caught).toBeUndefined();
      if (restart) {
        await bridge.shutdownA2A(); bridge = f.bridge(); await settle(bridge);
        expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce(); expect(f.dispatchReply).toHaveBeenCalledOnce();
        await bridge.shutdownA2A();
        // Model an explicitly resumed source turn using only its persisted intent.
        const path = join(state.dir, (await readdir(state.dir)).find(name => name.startsWith("companion-") && name.endsWith(".json"))!);
        const journal = JSON.parse(await readFile(path, "utf8")), job: any = Object.values(journal.jobs)[0];
        job.state = "pending"; job.nativeComplete = false;
        if (restart === "legacy") { delete job.toolSends["original-alias"].whatsappDestinationEvidence; delete saved.whatsappDestinationEvidence; }
        await writeFile(path, JSON.stringify(journal));
        f.dispatchReply.mockImplementationOnce(async (input: any) => { try { await exercise(input, false); } catch (error) { caught = error; } return { dispatched: true }; });
        bridge = f.bridge(); await settle(bridge);
        expect(f.dispatchReply).toHaveBeenCalledTimes(2); expect(caught).toBeUndefined();
      }
      expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(3);
    } finally { await bridge.shutdownA2A(); }
  },
);

it("keeps distinct groups with identical members and explicit new groups independent", async () => {
  const f = fixture(), bridge = f.bridge();
  const firstId = aliasConversation, secondId = "abcdefab-0000-4000-8000-000000000003";
  const participants = ["+15555550124", "+15555550125"];
  f.identity.getWhatsAppConversation.mockImplementation(async (id: string) => ({ id: id.toLowerCase(), agentIdentityId: f.identity.id,
    isGroup: true, participants, unresolvedParticipantCount: 0 }));
  f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }));
  let caught: unknown;
  f.dispatchReply.mockImplementationOnce(async (input: any) => {
    try {
      const tools = new Map<string, any>();
      registerWhatsAppTools({ registerTool(def: any) { const tool = typeof def === "function" ? def({ sessionKey: input.routeSessionKey }) : def; tools.set(tool.name, tool); } }, f.runtime);
      const send = tools.get("inkbox_send_whatsapp");
      const original = { conversationId: firstId, replyToMessageId: aliasQuote, text: "Answer", idempotencyKey: "group-original" };
      expect((await send.execute("group-first", original)).details.requestAccepted).toBe(false);
      expect((await send.execute("group-case", { conversationId: firstId.toUpperCase(), text: "Answer", idempotencyKey: "group-case" })).details)
        .toMatchObject({ sendAttempted: false, idempotencyKey: original.idempotencyKey });
      expect((await send.execute("group-second", { conversationId: secondId, text: "Answer" })).isError).not.toBe(true);
      expect((await send.execute("group-create", { to: participants, groupName: "Team", text: "Answer" })).isError).not.toBe(true);
      expect((await send.execute("group-repeat", { to: participants, groupName: "Team", text: "Answer" })).isError).not.toBe(true);
      expect((await send.execute("group-exact", original)).isError).not.toBe(true);
    } catch (error) { caught = error; }
    return { dispatched: true };
  });
  try {
    await dispatchInbound(event(), bridge.handlers); await settle(bridge); expect(caught).toBeUndefined();
    const requests = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
    expect(requests).toHaveLength(5); expect(requests[1].conversationId).toBe(secondId);
    expect(requests[2]).toMatchObject({ to: participants, groupName: "Team" }); expect(requests[2]).not.toHaveProperty("conversationId");
    expect(requests[3].idempotencyKey).not.toBe(requests[2].idempotencyKey); expect(requests[4]).toEqual(requests[0]);
  } finally { await bridge.shutdownA2A(); }
});
