import { describe, it, expect, vi } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import {
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
  }> = {},
) {
  const list = overrides.list ?? vi.fn(async () => []);
  const create = overrides.create ?? vi.fn();
  const update = overrides.update ?? vi.fn();
  const client = {
    webhooks: { subscriptions: { list, create, update } },
  };
  return { client: client as any, list, create, update };
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
