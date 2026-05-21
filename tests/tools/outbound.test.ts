import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSendEmail } from "../../src/tools/send-email.js";
import { registerSendSms } from "../../src/tools/send-sms.js";
import { registerForwardEmail } from "../../src/tools/forward-email.js";
import { registerPlaceCall } from "../../src/tools/place-call.js";
import type { InkboxRuntime } from "../../src/client.js";

// Tiny harness — `api.registerTool` collects tools into a map so the test
// can fetch the execute() fn by name and call it directly. Skips the
// optional/metadata bookkeeping; we only care about runtime behavior.
interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): { api: any; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool: (def: RegisteredTool, _opts?: any) => {
      tools.set(def.name, def);
    },
  };
  return { api, tools };
}

// Build a mock InkboxRuntime that exposes the methods the outbound tools
// actually call. Tests inject the spy fns they care about.
function createMockRuntime(overrides: {
  sendEmail?: ReturnType<typeof vi.fn>;
  sendText?: ReturnType<typeof vi.fn>;
  forwardEmail?: ReturnType<typeof vi.fn>;
  placeCall?: ReturnType<typeof vi.fn>;
} = {}): InkboxRuntime {
  const identity = {
    sendEmail: overrides.sendEmail ?? vi.fn().mockResolvedValue({ id: "msg-1" }),
    sendText: overrides.sendText ?? vi.fn().mockResolvedValue({ id: "txt-1", deliveryStatus: "queued" }),
    forwardEmail: overrides.forwardEmail ?? vi.fn().mockResolvedValue({ id: "fwd-1" }),
    placeCall: overrides.placeCall ?? vi.fn().mockResolvedValue({ id: "call-1", status: "queued", rateLimit: { callsRemaining: 17 } }),
  };
  return {
    getIdentity: () => Promise.resolve(identity as any),
    getClient: () => Promise.resolve({} as any),
  };
}

describe("registerSendEmail", () => {
  it("calls identity.sendEmail with the provided params", async () => {
    const { api, tools } = createApi();
    const sendEmail = vi.fn().mockResolvedValue({ id: "msg-99" });
    registerSendEmail(api, createMockRuntime({ sendEmail }));
    const tool = tools.get("inkbox_send_email")!;
    const out = await tool.execute("turn-1", {
      to: ["ada@example.com"],
      subject: "hi",
      bodyText: "hello",
    });
    expect(sendEmail).toHaveBeenCalledWith({
      to: ["ada@example.com"],
      subject: "hi",
      bodyText: "hello",
      bodyHtml: undefined,
      cc: undefined,
      bcc: undefined,
      inReplyToMessageId: undefined,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("msg-99");
    expect(out.content[0].text).toContain("ada@example.com");
  });

  it("blocks recipients not on the allowlist", async () => {
    const { api, tools } = createApi();
    const sendEmail = vi.fn();
    registerSendEmail(api, createMockRuntime({ sendEmail }), ["ada@example.com"]);
    const tool = tools.get("inkbox_send_email")!;
    const out = await tool.execute("turn-1", {
      to: ["evil@example.com"],
      subject: "hi",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("evil@example.com");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("blocks when ANY of to/cc/bcc isn't on the allowlist", async () => {
    const { api, tools } = createApi();
    const sendEmail = vi.fn();
    registerSendEmail(api, createMockRuntime({ sendEmail }), ["ok@example.com"]);
    const tool = tools.get("inkbox_send_email")!;
    const out = await tool.execute("turn-1", {
      to: ["ok@example.com"],
      cc: ["sneaky@example.com"],
      subject: "hi",
    });
    expect(out.isError).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("surfaces SDK errors via mapInkboxError", async () => {
    const { api, tools } = createApi();
    const { InkboxAPIError } = await import("@inkbox/sdk");
    const sendEmail = vi.fn().mockRejectedValue(new InkboxAPIError(404, "no mailbox"));
    registerSendEmail(api, createMockRuntime({ sendEmail }));
    const tool = tools.get("inkbox_send_email")!;
    const out = await tool.execute("turn-1", { to: ["a@x.com"], subject: "hi" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Not found");
  });
});

describe("registerSendSms", () => {
  it("calls identity.sendText and reports back", async () => {
    const { api, tools } = createApi();
    const sendText = vi.fn().mockResolvedValue({ id: "txt-7", deliveryStatus: "queued" });
    registerSendSms(api, createMockRuntime({ sendText }));
    const tool = tools.get("inkbox_send_sms")!;
    const out = await tool.execute("turn-1", { to: "+15551234567", text: "hi" });
    expect(sendText).toHaveBeenCalledWith({ to: "+15551234567", text: "hi" });
    expect(out.content[0].text).toContain("txt-7");
    expect(out.content[0].text).toContain("queued");
  });

  it("blocks non-allowlisted recipient", async () => {
    const { api, tools } = createApi();
    const sendText = vi.fn();
    registerSendSms(api, createMockRuntime({ sendText }), ["+15551234567"]);
    const tool = tools.get("inkbox_send_sms")!;
    const out = await tool.execute("turn-1", { to: "+15559999999", text: "spam" });
    expect(out.isError).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("hoists 403 recipient_not_opted_in to plain language", async () => {
    const { api, tools } = createApi();
    const { InkboxAPIError } = await import("@inkbox/sdk");
    const sendText = vi.fn().mockRejectedValue(new InkboxAPIError(403, "recipient_not_opted_in"));
    registerSendSms(api, createMockRuntime({ sendText }));
    const tool = tools.get("inkbox_send_sms")!;
    const out = await tool.execute("turn-1", { to: "+15551234567", text: "hi" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("opted in");
    expect(out.content[0].text).toContain("START");
  });
});

describe("registerForwardEmail", () => {
  it("forwards through identity.forwardEmail", async () => {
    const { api, tools } = createApi();
    const forwardEmail = vi.fn().mockResolvedValue({ id: "fwd-2" });
    registerForwardEmail(api, createMockRuntime({ forwardEmail }));
    const tool = tools.get("inkbox_forward_email")!;
    const out = await tool.execute("turn-1", {
      messageId: "orig-1",
      to: ["b@x.com"],
    });
    expect(forwardEmail).toHaveBeenCalledTimes(1);
    expect(forwardEmail.mock.calls[0][0]).toBe("orig-1");
    expect(out.content[0].text).toContain("fwd-2");
  });

  it("allowlist applies across to/cc/bcc on forward", async () => {
    const { api, tools } = createApi();
    const forwardEmail = vi.fn();
    registerForwardEmail(api, createMockRuntime({ forwardEmail }), ["allowed@x.com"]);
    const tool = tools.get("inkbox_forward_email")!;
    const out = await tool.execute("turn-1", {
      messageId: "orig-1",
      bcc: ["blocked@x.com"],
    });
    expect(out.isError).toBe(true);
    expect(forwardEmail).not.toHaveBeenCalled();
  });
});

describe("registerPlaceCall", () => {
  it("calls identity.placeCall with toNumber + WS url", async () => {
    const { api, tools } = createApi();
    const placeCall = vi.fn().mockResolvedValue({
      id: "call-9",
      status: "queued",
      rateLimit: { callsRemaining: 3 },
    });
    registerPlaceCall(api, createMockRuntime({ placeCall }));
    const tool = tools.get("inkbox_place_call")!;
    const out = await tool.execute("turn-1", {
      toNumber: "+15551234567",
      clientWebsocketUrl: "wss://example.com/ws",
    });
    expect(placeCall).toHaveBeenCalledWith({
      toNumber: "+15551234567",
      clientWebsocketUrl: "wss://example.com/ws",
    });
    expect(out.content[0].text).toContain("call-9");
    expect(out.content[0].text).toContain("callsRemaining=3");
  });

  it("respects the recipient allowlist", async () => {
    const { api, tools } = createApi();
    const placeCall = vi.fn();
    registerPlaceCall(api, createMockRuntime({ placeCall }), ["+15551234567"]);
    const tool = tools.get("inkbox_place_call")!;
    const out = await tool.execute("turn-1", {
      toNumber: "+15559999999",
      clientWebsocketUrl: "wss://example.com/ws",
    });
    expect(out.isError).toBe(true);
    expect(placeCall).not.toHaveBeenCalled();
  });
});
