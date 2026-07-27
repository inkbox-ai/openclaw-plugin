import { describe, it, expect, vi } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import {
  A2A_EVENT_TYPES,
  IMESSAGE_EVENT_TYPES,
  MAIL_EVENT_TYPES,
  TEXT_EVENT_TYPES,
  reconcileWebhookSubscription,
} from "../../src/inbound/subscriptions.js";

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    organizationId: "org-1",
    mailboxId: null,
    phoneNumberId: null,
    url: "https://example.com/webhook",
    eventTypes: ["message.received"],
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeClient(
  overrides: Partial<{
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const list = overrides.list ?? vi.fn(async () => []);
  const create = overrides.create ?? vi.fn();
  const update = overrides.update ?? vi.fn();
  const del = overrides.delete ?? vi.fn(async () => {});
  const client = {
    webhooks: { subscriptions: { list, create, update, delete: del } },
  };
  return { client: client as any, list, create, update, delete: del };
}

describe("reconcileWebhookSubscription", () => {
  it("creates a subscription when the owner has none", async () => {
    const { client, list, create, update } = makeClient({
      create: vi.fn(async (opts: any) => makeSub({ ...opts, mailboxId: opts.mailboxId })),
    });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(list).toHaveBeenCalledWith({ mailboxId: "mb-1" });
    expect(create).toHaveBeenCalledWith({
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    expect(update).not.toHaveBeenCalled();
    expect(result?.mailboxId).toBe("mb-1");
  });

  it("creates an identity-owned iMessage subscription", async () => {
    const { client, list, create } = makeClient({
      create: vi.fn(async (opts: any) => makeSub({ ...opts })),
    });

    const result = await reconcileWebhookSubscription(client, {
      agentIdentityId: "identity-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: IMESSAGE_EVENT_TYPES,
    });

    expect(list).toHaveBeenCalledWith({ agentIdentityId: "identity-1" });
    expect(create).toHaveBeenCalledWith({
      agentIdentityId: "identity-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: [...IMESSAGE_EVENT_TYPES],
    });
    expect(result?.url).toBe("https://example.com/inkbox/webhook");
  });

  it("keeps a same-path A2A subscription while creating iMessage", async () => {
    const a2a = makeSub({
      id: "sub-a2a",
      agentIdentityId: "identity-1",
      url: "https://example.com/inkbox/webhook?channel=a2a",
      eventTypes: [...A2A_EVENT_TYPES],
    });
    const { client, create, update, delete: del } = makeClient({
      list: vi.fn(async () => [a2a]),
      create: vi.fn(async (opts: any) => makeSub({ ...opts })),
    });

    await reconcileWebhookSubscription(client, {
      agentIdentityId: "identity-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: IMESSAGE_EVENT_TYPES,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("rejects more than one subscription owner", async () => {
    const { client } = makeClient();
    await expect(
      reconcileWebhookSubscription(client, {
        mailboxId: "mb-1",
        agentIdentityId: "identity-1",
        url: "https://example.com/inkbox/webhook",
        eventTypes: IMESSAGE_EVENT_TYPES,
      }),
    ).rejects.toThrow(/exactly one of/i);
  });

  it("no-ops when matching URL + matching event-types", async () => {
    const existing = makeSub({
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const { client, create, update } = makeClient({
      list: vi.fn(async () => [existing]),
    });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it("PATCHes when matching URL but event-types drifted", async () => {
    const existing = makeSub({
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: ["message.received"],
    });
    const { client, update } = makeClient({
      list: vi.fn(async () => [existing]),
      update: vi.fn(async (_id: string, opts: any) =>
        makeSub({ ...existing, eventTypes: opts.eventTypes }),
      ),
    });

    await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(update).toHaveBeenCalledWith("sub-1", {
      eventTypes: [...MAIL_EVENT_TYPES],
    });
  });

  it("creates a new sub for a new URL and leaves other rows alone", async () => {
    const other = makeSub({
      id: "sub-other",
      phoneNumberId: "phone-1",
      url: "https://other.example.com/hook",
      eventTypes: ["text.received"],
    });
    const { client, create, update } = makeClient({
      list: vi.fn(async () => [other]),
      create: vi.fn(async (opts: any) =>
        makeSub({ id: "sub-new", phoneNumberId: opts.phoneNumberId, url: opts.url, eventTypes: opts.eventTypes }),
      ),
    });

    const result = await reconcileWebhookSubscription(client, {
      phoneNumberId: "phone-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: TEXT_EVENT_TYPES,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(result?.id).toBe("sub-new");
  });

  it("repoints a stale plugin row when the base URL changed", async () => {
    // Same /inkbox/webhook route, old base URL (e.g. a CI publicUrl boot):
    // that row is ours — repoint it instead of leaving it pointed at a dead
    // host.
    const stale = makeSub({
      id: "sub-stale",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const { client, create, update, delete: del } = makeClient({
      list: vi.fn(async () => [stale]),
      update: vi.fn(async (_id: string, opts: any) => makeSub({ ...stale, ...opts })),
    });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("sub-stale", {
      url: "https://tunnel.example.com/inkbox/webhook",
    });
    expect(result?.url).toBe("https://tunnel.example.com/inkbox/webhook");
  });

  it("repoints and patches event types together when both drifted", async () => {
    const stale = makeSub({
      id: "sub-stale",
      phoneNumberId: "phone-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: ["text.received"],
    });
    const { client, update } = makeClient({
      list: vi.fn(async () => [stale]),
      update: vi.fn(async (_id: string, opts: any) => makeSub({ ...stale, ...opts })),
    });

    await reconcileWebhookSubscription(client, {
      phoneNumberId: "phone-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: TEXT_EVENT_TYPES,
    });

    expect(update).toHaveBeenCalledWith("sub-stale", {
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: [...TEXT_EVENT_TYPES],
    });
  });

  it("deletes stale plugin rows when a row already matches the desired URL", async () => {
    const match = makeSub({
      id: "sub-match",
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const stale = makeSub({
      id: "sub-stale",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const { client, create, update, delete: del } = makeClient({
      list: vi.fn(async () => [match, stale]),
    });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(result).toBe(match);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("sub-stale");
  });

  it("deletes extra stale rows after repointing the first", async () => {
    const staleA = makeSub({
      id: "sub-stale-a",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const staleB = makeSub({
      id: "sub-stale-b",
      mailboxId: "mb-1",
      url: "https://old-tunnel.example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const { client, update, delete: del } = makeClient({
      list: vi.fn(async () => [staleA, staleB]),
      update: vi.fn(async (_id: string, opts: any) => makeSub({ ...staleA, ...opts })),
    });

    await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(update).toHaveBeenCalledWith("sub-stale-a", {
      url: "https://tunnel.example.com/inkbox/webhook",
    });
    expect(del).toHaveBeenCalledWith("sub-stale-b");
  });

  it("leaves other consumers' rows on different paths alone when repointing", async () => {
    const stale = makeSub({
      id: "sub-stale",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const foreign = makeSub({
      id: "sub-foreign",
      mailboxId: "mb-1",
      url: "https://consumer.example.com/their/hook",
      eventTypes: ["message.received"],
    });
    const accountScoped = makeSub({
      id: "sub-account-scoped",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/acct2/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const { client, update, delete: del } = makeClient({
      list: vi.fn(async () => [foreign, stale, accountScoped]),
      update: vi.fn(async (_id: string, opts: any) => makeSub({ ...stale, ...opts })),
    });

    await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("sub-stale", {
      url: "https://tunnel.example.com/inkbox/webhook",
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("on repoint 409: adopts the raced desired-URL row and deletes the stale one", async () => {
    const stale = makeSub({
      id: "sub-stale",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const raced = makeSub({
      id: "sub-raced",
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([stale, raced]);
    const update = vi.fn().mockRejectedValue(
      new InkboxAPIError(
        409,
        { detail: "An active subscription with this URL already exists on this owner" } as any,
      ),
    );
    const { client, delete: del } = makeClient({ list, update });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(result).toBe(raced);
    expect(del).toHaveBeenCalledWith("sub-stale");
  });

  it("a stale-row delete failure does not fail the reconcile", async () => {
    const match = makeSub({
      id: "sub-match",
      mailboxId: "mb-1",
      url: "https://tunnel.example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const stale = makeSub({
      id: "sub-stale",
      mailboxId: "mb-1",
      url: "http://127.0.0.1:18789/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const del = vi.fn().mockRejectedValue(new InkboxAPIError(500, "boom"));
    const logger = { warn: vi.fn(), info: vi.fn() } as any;
    const { client } = makeClient({
      list: vi.fn(async () => [match, stale]),
      delete: del,
    });

    const result = await reconcileWebhookSubscription(
      client,
      {
        mailboxId: "mb-1",
        url: "https://tunnel.example.com/inkbox/webhook",
        eventTypes: MAIL_EVENT_TYPES,
      },
      logger,
    );

    expect(result).toBe(match);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("on 409 duplicate-URL: re-lists and returns the existing row", async () => {
    const existing = makeSub({
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: [...MAIL_EVENT_TYPES],
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existing]);
    const create = vi.fn().mockRejectedValue(
      new InkboxAPIError(
        409,
        { detail: "An active subscription with this URL already exists on this owner" } as any,
      ),
    );
    const { client, update } = makeClient({ list, create });

    const result = await reconcileWebhookSubscription(client, {
      mailboxId: "mb-1",
      url: "https://example.com/inkbox/webhook",
      eventTypes: MAIL_EVENT_TYPES,
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it("on 409 cap exceeded: logs and returns null", async () => {
    const create = vi.fn().mockRejectedValue(
      new InkboxAPIError(
        409,
        {
          detail:
            "Owner already has 20 active webhook subscriptions (max 20). Delete one before creating another.",
        } as any,
      ),
    );
    const { client } = makeClient({ create });
    const logger = { warn: vi.fn() } as any;

    const result = await reconcileWebhookSubscription(
      client,
      {
        mailboxId: "mb-1",
        url: "https://example.com/inkbox/webhook",
        eventTypes: MAIL_EVENT_TYPES,
      },
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("throws when both or neither owner id are provided", async () => {
    const { client } = makeClient();
    await expect(
      reconcileWebhookSubscription(client, {
        url: "https://x/hook",
        eventTypes: MAIL_EVENT_TYPES,
      } as any),
    ).rejects.toThrow();
    await expect(
      reconcileWebhookSubscription(client, {
        mailboxId: "mb-1",
        phoneNumberId: "phone-1",
        url: "https://x/hook",
        eventTypes: MAIL_EVENT_TYPES,
      } as any),
    ).rejects.toThrow();
  });
});
