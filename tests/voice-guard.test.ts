import { describe, expect, it, vi } from "vitest";
import {
  markInkboxVoiceTurnActive,
  registerInkboxVoiceToolGuard,
  shouldBlockInkboxOutboundToolDuringVoice,
} from "../src/voice-guard.js";

describe("Inkbox voice tool guard", () => {
  it("blocks SMS/email outbound tools only while a voice turn is active", () => {
    const clear = markInkboxVoiceTurnActive("session-1", { callId: "call-1" });

    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_send_sms", "session-1")).toBe(true);
    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_send_email", "session-1")).toBe(true);
    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_forward_email", "session-1")).toBe(true);
    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_create_note", "session-1")).toBe(false);
    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_send_sms", "session-2")).toBe(false);

    clear();
    expect(shouldBlockInkboxOutboundToolDuringVoice("inkbox_send_sms", "session-1")).toBe(false);
  });

  it("registers a before_tool_call hook that blocks voice-call SMS fallback", () => {
    const hooks = new Map<string, any>();
    const api = {
      registerHook: vi.fn((event: string, handler: any) => hooks.set(event, handler)),
    };
    registerInkboxVoiceToolGuard(api);
    const handler = hooks.get("before_tool_call");
    const clear = markInkboxVoiceTurnActive("voice-session", { callId: "call-2" });

    const blocked = handler(
      { toolName: "inkbox_send_sms", params: { to: "+15551234567", text: "hi" } },
      { sessionKey: "voice-session" },
    );
    const allowed = handler(
      { toolName: "inkbox_create_contact", params: {} },
      { sessionKey: "voice-session" },
    );

    clear();
    expect(api.registerHook).toHaveBeenCalledWith(
      "before_tool_call",
      expect.any(Function),
      expect.objectContaining({ name: "inkbox-voice-outbound-tool-guard" }),
    );
    expect(blocked).toEqual({
      block: true,
      blockReason: expect.stringContaining("Inkbox voice call is active"),
    });
    expect(allowed).toBeUndefined();
  });
});
