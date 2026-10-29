import { readFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { whatsappRecipients } from "../src/whatsapp.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/whatsapp-v2.json", import.meta.url), "utf8"));
afterEach(() => vi.unstubAllGlobals());
it("uses the shared recipient matrix without accepting group identifiers as phone numbers", () => {
  for (const test of fixture.send_cases.filter((item: any) => item.body.to && !item.body.reply_to_message_id && !item.body.conversation_id)) {
    if (test.valid) expect(whatsappRecipients(test.body.to).length).toBeGreaterThan(0);
    else expect(() => whatsappRecipients(test.body.to)).toThrow();
  }
});
it("retains the real SDK wire contract for quoted sends, threads, and uncertain reactions", async () => {
  const calls: { path: string; body: any; key: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined, key: new Headers(options?.headers).get("Idempotency-Key") });
    const data = path.includes("/identities/") ? { id: fixture.message.agent_identity_id, organization_id: "org_fixture", agent_handle: "example", created_at: fixture.message.created_at, updated_at: fixture.message.updated_at }
      : path.includes("/reactions") ? { reaction: fixture.uncertain_reaction }
      : path.endsWith("/thread") ? fixture.thread : { message: fixture.message };
    return new Response(JSON.stringify(data), { status: options?.method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
  }));
  const identity = await new Inkbox({ apiKey: "synthetic-contract-key", baseUrl: "https://contract.example" }).getIdentity("example");
  const sent = await identity.sendWhatsApp({ conversationId: fixture.message.conversation_id, replyToMessageId: fixture.message.reply_to_message_id, text: "Reply", idempotencyKey: "quoted-original" });
  expect(sent.threadId).toBe(fixture.message.thread_id);
  expect(calls.at(-1)).toMatchObject({ body: { conversation_id: fixture.message.conversation_id, reply_to_message_id: fixture.message.reply_to_message_id, text: "Reply" }, key: "quoted-original" });
  const thread = await identity.getWhatsAppThread(fixture.message.id, { limit: 50 });
  expect(thread.conversationId).toBe(fixture.thread.conversation_id);
  expect(thread.messages.map((message) => message.id)).toEqual(fixture.thread.messages.map((message: any) => message.id));
  const reaction = await identity.sendWhatsAppReaction({ messageId: fixture.message.id, reaction: "eyes", idempotencyKey: "reaction-original" });
  expect(reaction.status).toBe("uncertain");
  expect(reaction.revision).toBe(2);
  expect(calls.at(-1)).toMatchObject({ body: { message_id: fixture.message.id, reaction: "eyes" }, key: "reaction-original" });
});

it("retains the real SDK's uncertainty limitation when a retry ends in a public rejection", async () => {
  const requests: { body: string; key: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (new URL(String(url)).pathname.includes("/identities/")) return new Response(JSON.stringify({
      id: fixture.message.agent_identity_id, organization_id: "org_fixture", agent_handle: "example",
      created_at: fixture.message.created_at, updated_at: fixture.message.updated_at,
    }), { status: 200, headers: { "content-type": "application/json" } });
    requests.push({ body: String(options?.body), key: new Headers(options?.headers).get("Idempotency-Key") });
    if (requests.length === 1) throw Object.assign(new Error("response timed out"), { name: "TimeoutError" });
    return new Response(JSON.stringify({ detail: { error: "whatsapp_reply_required_for_links" } }), {
      status: 422, headers: { "content-type": "application/json" },
    });
  }));
  const identity = await new Inkbox({ apiKey: "synthetic-contract-key", baseUrl: "https://contract.example" }).getIdentity("example");
  await expect(identity.sendWhatsApp({ conversationId: fixture.message.conversation_id,
    replyToMessageId: fixture.message.reply_to_message_id, text: "See https://example.com", idempotencyKey: "retained-quote-key" }))
    .rejects.toMatchObject({ statusCode: 422, detail: { error: "whatsapp_reply_required_for_links" }, idempotencyKey: "retained-quote-key" });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});
