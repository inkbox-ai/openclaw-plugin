import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollSendOutcome, reportedInline, sendOutcome } from "../../src/tools/send-outcome.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "send-outcome-"));
  vi.stubEnv("INKBOX_SEND_OUTCOME_HOME", home);
  vi.stubEnv("INKBOX_SEND_POLL_SECONDS", "0.18");
  vi.stubEnv("INKBOX_SEND_POLL_INTERVAL_SECONDS", "0.05");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("send outcomes", () => {
  it.each([
    ["imessage", "imessage", "sent", false, false],
    ["imessage", "sms", "sent", false, true],
    ["imessage", "rcs", "delivered", false, true],
    ["imessage", "imessage", "sent", true, true],
    ["imessage", "imessage", "error", false, true],
    ["sms", "sms", "sent", false, false],
    ["sms", "sms", "delivery_failed", true, true],
    ["sms", "sms", "delivery_unconfirmed", false, true],
  ])("derives %s %s %s group=%s", (kind, service, status, group, final) => {
    expect(sendOutcome({ status, service }, kind as "sms" | "imessage", Boolean(group)).delivery_final).toBe(final);
  });
  it("prefers the server flag and does not claim transport while pending", () => {
    expect(sendOutcome({ status: "pending", service: "imessage", deliveryFinal: false }, "imessage").service).toBeNull();
    expect(sendOutcome({ status: "sent", service: "sms", deliveryFinal: false }, "imessage").delivery_final).toBe(false);
    expect(sendOutcome({ status: "delivery_unconfirmed" }, "sms").note).toContain("outcome is unknown");
  });
  it("stops at final transport and skips already-final reads", async () => {
    const get = vi.fn().mockResolvedValue({ status: "sent", service: "sms" });
    const runtime = { getClient: async () => ({ imessages: { get } }) };
    const result = await pollSendOutcome(runtime, {}, "imessage", { id: "message", status: "pending" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.delivery_final).toBe(true);
    expect(result.note).toContain("No device delivery receipt");
    await pollSendOutcome(runtime, {}, "imessage", { id: "final", status: "delivered" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("returns the latest accepted state when GET fails", async () => {
    const getText = vi.fn().mockResolvedValueOnce({ deliveryStatus: "sent" }).mockRejectedValueOnce(new Error("read unavailable"));
    const result = await pollSendOutcome({ getClient: vi.fn() }, { getText }, "sms", { id: "text", deliveryStatus: "queued" });
    expect(result.status).toBe("sent");
    expect(result.delivery_final).toBe(false);
    expect(getText).toHaveBeenCalledTimes(2);
  });
  it("bounds a hanging GET and never sends again", async () => {
    const getText = vi.fn(() => new Promise(() => {}));
    const start = performance.now();
    const result = await pollSendOutcome({ getClient: vi.fn() }, { getText }, "sms", { id: "slow", deliveryStatus: "queued" });
    expect(performance.now() - start).toBeLessThan(700);
    expect(getText).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });
  it("lets an in-flight observation suppress a duplicate failure wake", async () => {
    let finish!: (message: any) => void;
    const getText = vi.fn(() => new Promise<any>((resolve) => { finish = resolve; }));
    const polling = pollSendOutcome({ getClient: vi.fn() }, { getText }, "sms", { id: "race", deliveryStatus: "queued" });
    const callback = reportedInline("race");
    await new Promise((resolve) => setTimeout(resolve, 65));
    finish({ deliveryStatus: "delivery_failed", errorDetail: "Unavailable" });
    expect((await polling).error_detail).toBe("Unavailable");
    expect(await callback).toBe(true);
  });
  it("tolerates an older SDK without message GET", async () => {
    const result = await pollSendOutcome({ getClient: async () => ({}) }, {}, "imessage", { id: "old", status: "pending" });
    expect(result.status).toBe("pending");
    expect(result.delivery_final).toBe(false);
  });
});

it("does not ask for a second retry when the webhook won the race", async () => {
  expect(await reportedInline("first")).toBe(false);
  const result = await pollSendOutcome({ getClient: vi.fn() }, {}, "imessage", { id: "first", status: "error" });
  expect(result.note).toContain("do not start another retry");
});

it("preserves observed transport before finality and identifies MMS", () => {
  expect(sendOutcome({ status: "queued", service: "sms" }, "imessage").service).toBe("sms");
  expect(sendOutcome({ deliveryStatus: "sent", type: "mms" }, "sms").service).toBe("mms");
});

it("caps the number of status reads even with a longer observation window", async () => {
  vi.stubEnv("INKBOX_SEND_POLL_SECONDS", "10");
  vi.stubEnv("INKBOX_SEND_POLL_INTERVAL_SECONDS", "0.05");
  const getText = vi.fn().mockResolvedValue({ deliveryStatus: "queued" });
  const result = await pollSendOutcome({ getClient: vi.fn() }, { getText }, "sms", { id: "read-cap", deliveryStatus: "queued" });
  expect(result.delivery_final).toBe(false);
  expect(getText).toHaveBeenCalledTimes(20);
});

it("keeps the inline receipt when an accepted message is observed again", async () => {
  const runtime = { getClient: async () => ({}) };
  await pollSendOutcome(runtime, {}, "imessage", { id: "repeat", status: "error" });
  await pollSendOutcome(runtime, {}, "imessage", { id: "repeat", status: "pending" });
  expect(await reportedInline("repeat")).toBe(true);
});

it("keeps ambiguous delivery unknown and preserves safe rejection explanations", () => {
  const uncertain = sendOutcome({ status: "error", errorCode: "send_outcome_ambiguous", errorMessage: "Delivery could not be confirmed." }, "imessage");
  expect(uncertain.delivery_final).toBe(true);
  expect(uncertain.error_detail).toBe("Delivery could not be confirmed.");
  expect(uncertain.note).toContain("unknown; do not resend");
  expect(uncertain.note).not.toContain("Delivery failed");
  const rejected = sendOutcome({ status: "error", error_code: "message_send_rejected", error_message: "Message content could not be sent." }, "imessage");
  expect(rejected.error_detail).toBe("Message content could not be sent.");
});
