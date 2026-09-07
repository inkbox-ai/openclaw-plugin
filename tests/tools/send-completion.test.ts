import { describe, expect, it, vi } from "vitest";
import { registerSendEmail } from "../../src/tools/send-email.js";
import { registerSendSms } from "../../src/tools/send-sms.js";
import { registerSendIMessage } from "../../src/tools/send-imessage.js";
import { registerForwardEmail } from "../../src/tools/forward-email.js";

const cases = [
  { name: "email", register: registerSendEmail, method: "sendEmail", params: { to: ["person@example.test"], subject: "Requested", bodyText: "requested body" } },
  { name: "SMS", register: registerSendSms, method: "sendText", params: { to: "+15555550123", text: "requested body" } },
  { name: "iMessage", register: registerSendIMessage, method: "sendIMessage", params: { to: "+15555550123", text: "requested body" } },
  { name: "forward", register: registerForwardEmail, method: "forwardEmail", params: { messageId: "original-message", to: ["person@example.test"], bodyText: "requested body" } },
];

describe.each(cases)("$name explicit silent completion", ({ register, method, params }) => {
  function harness(allowedRecipients?: string[]) {
    const send = vi.fn().mockResolvedValue({ id: "accepted-message", conversationId: "conversation", deliveryStatus: "queued" });
    let tool: any;
    register({ registerTool: (value: any) => { tool = value; } }, {
      getIdentity: async () => ({ [method]: send }),
    } as any, allowedRecipients);
    return { tool, send };
  }

  it("ends only an opted-in accepted send without leaking the control argument to the SDK", async () => {
    const { tool, send } = harness();
    const result = await tool.execute("call", { ...params, completeSilently: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].at(-1)).not.toHaveProperty("completeSilently");
    expect(result).toMatchObject({
      terminate: true,
      details: { inkboxSendCompletion: { accepted: true, completeSilently: true } },
    });
    expect(result.isError).toBeUndefined();
    if (method === "sendText") expect(result.details.inkboxSendSms).toEqual({ sent: true });
  });

  it.each([undefined, false])("leaves ordinary send completion open (%s)", async (completeSilently) => {
    const { tool, send } = harness();
    const result = await tool.execute("call", { ...params, completeSilently });
    expect(send).toHaveBeenCalledOnce();
    expect(result.terminate).toBeUndefined();
    expect(result.details?.inkboxSendCompletion).toBeUndefined();
  });

  it("does not declare silent completion after an ambiguous API failure", async () => {
    const { tool, send } = harness();
    send.mockRejectedValueOnce(new Error("connection lost"));
    const result = await tool.execute("call", { ...params, completeSilently: true });
    expect(send).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(result.details?.inkboxSendCompletion).toBeUndefined();
  });

  it("does not suppress a blocked send", async () => {
    const { tool, send } = harness(["allowed@example.test"]);
    const result = await tool.execute("call", { ...params, completeSilently: true });
    expect(send).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(result.details?.inkboxSendCompletion).toBeUndefined();
  });
});
