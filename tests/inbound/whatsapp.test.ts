import { createHmac } from "node:crypto";
import { InkboxAPIError } from "@inkbox/sdk";
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
import { createCompanionReceiver } from "../../src/inbound/companion.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { bindNativeSource } from "../../src/native-source.js";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
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
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "conversation-a", conversation_id: "conversation-a" };
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
    expect(await next.whatsappDeliveryConversation("accepted-original-message")).toBe("conversation-a");
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
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "conversation-a", conversation_id: "conversation-a" };
    incoming.data.message._ordinaryAddressed = true;
    try {
      await receiver.accept(incoming); await receiver.idle();
      expect(submitError).toBeUndefined();
      expect(submit).toHaveBeenCalledOnce();
      expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledTimes(bound ? 0 : 1);
      if (bound && !uncertain) expect(await receiver.whatsappDeliveryConversation("sent-a")).toBe("conversation-a");
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
        const payload = { text: "Saved answer", mediaIds: ["owned-media"], idempotencyKey: "original-logical-key" };
        const first = await send.execute("first-call", payload);
        expect(first.isError).toBe(true);
        const saved = Object.values((await readJournal()).jobs)[0] as any;
        expect(saved.toolSends["first-call"]).toMatchObject({
          whatsappKey: "original-logical-key", whatsappMediaIds: ["owned-media"], text: "Saved answer",
        });
        expect(saved.toolSends["first-call"].whatsappRejection?.error).toBe(rejected ? "whatsapp_daily_limit_exceeded" : undefined);
        expect(first.details?.requestAccepted).toBe(rejected ? false : undefined);
        if (rejected) {
          expect(first.details).toEqual({ error: "whatsapp_daily_limit_exceeded", status_code: 429,
            quota: "whatsapp.texts_per_agent_identity_per_24h", limit: 50, used: 50,
            retry_condition: "window_reset", reset_at: "2026-10-27T00:00:00Z", retry_after_seconds: 60,
            idempotencyKey: "original-logical-key", requestAccepted: false, mediaIds: ["owned-media"] });
          expect(JSON.stringify(first)).not.toContain("private-provider-note");
          for (const changed of [{ ...payload, idempotencyKey: "new-key" }, { ...payload, text: "Changed answer" }, { ...payload, mediaIds: ["replacement-media"] }]) {
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
    incoming.companion = { channel: "whatsapp", phase: "ordinary", sequence: 1, scope_id: "conversation-a", conversation_id: "conversation-a" };
    incoming.data.message._ordinaryAddressed = true;
    try {
      await receiver.accept(incoming);
      await receiver.idle();
      expect(submit).toHaveBeenCalledOnce();
      expect(submitError).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
      if (rejected && retry) {
        expect(Object.keys((await readJournal()).jobs)).toHaveLength(0);
        expect(await receiver.whatsappDeliveryConversation("sent-a")).toBe("conversation-a");
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
  it("uses conversation-scoped group routing, retains quote metadata, and keeps automatic replies plain", async () => {
    const f = fixture(), b = f.bridge(), e = event();
    e.data.message.is_group = true;
    e.data.message.participants = ["+15555550123", "+15555550124"];
    e.data.message.thread_id = "thread-a";
    e.data.message.reply_to_message_id = "parent-a";
    await dispatchInbound(e, b.handlers); await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    const built = f.core.inbound.buildContext.mock.calls[0][0];
    expect(JSON.stringify(built)).toContain("group");
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ conversationId: "conversation-a" });
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).not.toHaveProperty("replyToMessageId");
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
    e.data.reaction = { id: "reaction-a", target_message_id: e.data.message.id, conversation_id: "conversation-a", agent_identity_id: f.identity.id, direction: "inbound", remote_number: "+15555550123", emoji: "👀", status: "applied", revision: 1 };
    await dispatchInbound(e, b.handlers); await settle(b); await dispatchInbound(e, b.handlers); await settle(b);
    expect(f.dispatchReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.core.inbound.buildContext.mock.calls[0][0])).toContain("context, not a new instruction");
    const own = structuredClone(e); own.id = "own-event"; own.data.reaction.id = "own-reaction"; own.data.reaction.direction = "outbound";
    await dispatchInbound(own, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledOnce();
    const hidden = structuredClone(e); hidden.id = "hidden-event"; hidden.data.message.is_blocked = true; hidden.data.reaction.id = "hidden-reaction";
    await dispatchInbound(hidden, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledOnce();
    const removed = structuredClone(e); removed.id = "removed-event"; removed.data.reaction.revision = 2; removed.data.reaction.status = "removed";
    await dispatchInbound(removed, b.handlers); await settle(b); expect(f.dispatchReply).toHaveBeenCalledTimes(2);
  });
});
