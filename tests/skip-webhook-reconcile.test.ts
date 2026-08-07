import { describe, expect, it, vi } from "vitest";
import { configureInkboxIdentityDelivery } from "../src/inbound/session.js";

// Startup normally points the identity's mailbox, phone number, iMessage, and
// A2A events at whatever URL the gateway just came up on. That is right when
// the gateway owns its ingress, and wrong when subscriptions are provisioned
// ahead of time: there the destination is already fixed, and the API key may
// not be permitted to change it, so writing on every start is redundant at
// best and fatal to startup at worst.

const WEBHOOK_URL = "https://agent.example/webhook";

function makeRuntime() {
  return {
    getIdentity: vi.fn(async () => {
      throw new Error("read the identity despite the skip flag");
    }),
    getClient: vi.fn(async () => {
      throw new Error("opened a client despite the skip flag");
    }),
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("skipWebhookReconcile", () => {
  it("touches nothing when enabled", async () => {
    const runtime = makeRuntime();
    const logger = makeLogger();

    await configureInkboxIdentityDelivery({
      runtime: runtime as never,
      webhookUrl: WEBHOOK_URL,
      logger: logger as never,
      skipWebhookReconcile: true,
    });

    expect(runtime.getIdentity).not.toHaveBeenCalled();
    expect(runtime.getClient).not.toHaveBeenCalled();
  });

  it("names the URL it expects deliveries to reach", async () => {
    const logger = makeLogger();

    await configureInkboxIdentityDelivery({
      runtime: makeRuntime() as never,
      webhookUrl: WEBHOOK_URL,
      logger: logger as never,
      skipWebhookReconcile: true,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(WEBHOOK_URL));
  });

  it("still reconciles when the flag is absent", async () => {
    // The runtime throws on first contact, so reaching it proves the default
    // path still runs rather than returning early.
    const runtime = makeRuntime();

    await expect(
      configureInkboxIdentityDelivery({
        runtime: runtime as never,
        webhookUrl: WEBHOOK_URL,
        logger: makeLogger() as never,
      }),
    ).rejects.toThrow();

    expect(runtime.getIdentity).toHaveBeenCalled();
  });

  it("still reconciles when explicitly false", async () => {
    const runtime = makeRuntime();

    await expect(
      configureInkboxIdentityDelivery({
        runtime: runtime as never,
        webhookUrl: WEBHOOK_URL,
        logger: makeLogger() as never,
        skipWebhookReconcile: false,
      }),
    ).rejects.toThrow();

    expect(runtime.getIdentity).toHaveBeenCalled();
  });
});
