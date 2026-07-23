import { describe, it, expect, vi } from "vitest";
import { dispatchInbound } from "../../src/inbound/dispatch.js";

// Minimal payload fixtures matching the wire shapes the SDK documents.
function mailEvent(eventType: string, fromContactId: string | null = "contact-from-1") {
  const contacts = [];
  if (fromContactId) {
    contacts.push({ bucket: "from", address: "ada@example.com", id: fromContactId, name: "Ada" });
  }
  return {
    event_type: eventType,
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      contacts,
      agent_identities: [],
      message: { id: "msg-1", subject: "hi", body_text: "hello" },
    },
  };
}

function textEvent(eventType: string, contactId: string | null = "contact-text-1") {
  return {
    event_type: eventType,
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      contacts: contactId ? [{ id: contactId, name: "Ada" }] : [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: { id: "txt-1", text: "hi" },
    },
  };
}

function legacyTextEvent(eventType: string, contactId: string | null = "contact-text-1") {
  return {
    event_type: eventType,
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      contact: contactId ? { id: contactId, name: "Ada" } : null,
      text_message: { id: "txt-1", text: "hi" },
    },
  };
}

function imessageEvent(eventType: string, contactId: string | null = "contact-im-1") {
  return {
    event_type: eventType,
    timestamp: "2026-06-10T00:00:00Z",
    data: {
      contacts: contactId ? [{ id: contactId, name: "Ada" }] : [],
      agent_identities: [],
      message: {
        id: "im-1",
        conversation_id: "imconv-1",
        direction: "inbound",
        remote_number: "+15551234567",
        content: "hi",
      },
      reaction: null,
    },
  };
}

function callEvent(contactId: string | null = "contact-call-1") {
  return {
    call_id: "call-1",
    remote_phone_number: "+15551234567",
    contacts: contactId ? [{ id: contactId, name: "Ada" }] : [],
    agent_identities: [],
  };
}

describe("dispatchInbound", () => {
  it("routes message.received to onMail", async () => {
    const onMail = vi.fn();
    const result = await dispatchInbound(mailEvent("message.received"), { onMail });
    expect(result.kind).toBe("mail");
    expect(onMail).toHaveBeenCalledTimes(1);
  });

  it("routes message.delivered to onMail as well (any message.* event)", async () => {
    const onMail = vi.fn();
    await dispatchInbound(mailEvent("message.delivered"), { onMail });
    expect(onMail).toHaveBeenCalledTimes(1);
  });

  it("routes text.received to onText", async () => {
    const onText = vi.fn();
    const result = await dispatchInbound(textEvent("text.received"), { onText });
    expect(result.kind).toBe("text");
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it("routes imessage.received to onIMessage", async () => {
    const onIMessage = vi.fn();
    const result = await dispatchInbound(imessageEvent("imessage.received"), { onIMessage });
    expect(result.kind).toBe("imessage");
    expect(onIMessage).toHaveBeenCalledTimes(1);
  });

  it("routes imessage delivery lifecycle to onIMessage as well (any imessage.* event)", async () => {
    const onIMessage = vi.fn();
    await dispatchInbound(imessageEvent("imessage.delivered"), { onIMessage });
    expect(onIMessage).toHaveBeenCalledTimes(1);
  });

  it("routes A2A lifecycle events to onA2A without applying contact filters", async () => {
    const onA2A = vi.fn();
    const payload = {
      event_type: "a2a.task.created",
      data: { task_id: "task-1", context_id: "context-1" },
    };

    const result = await dispatchInbound(
      payload,
      { onA2A },
      ["contact-allowed"],
    );

    expect(result.kind).toBe("a2a");
    expect(onA2A).toHaveBeenCalledWith(payload);
  });

  it("routes flat call payload to onCall", async () => {
    const onCall = vi.fn().mockReturnValue({ action: "answer", clientWebsocketUrl: "wss://x" });
    const result = await dispatchInbound(callEvent(), { onCall });
    expect(result.kind).toBe("call");
    expect(result.callDecision).toEqual({ action: "answer", clientWebsocketUrl: "wss://x" });
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("defaults to reject when no onCall handler is wired", async () => {
    const result = await dispatchInbound(callEvent(), {});
    expect(result.kind).toBe("call");
    expect(result.callDecision).toEqual({ action: "reject" });
  });

  describe("allowlist", () => {
    it("drops mail when from-contact is not on the list", async () => {
      const onMail = vi.fn();
      await dispatchInbound(mailEvent("message.received", "contact-blocked"), { onMail }, ["contact-allowed"]);
      expect(onMail).not.toHaveBeenCalled();
    });

    it("delivers mail when from-contact is on the list", async () => {
      const onMail = vi.fn();
      await dispatchInbound(mailEvent("message.received", "contact-allowed"), { onMail }, ["contact-allowed"]);
      expect(onMail).toHaveBeenCalledTimes(1);
    });

    it("drops text when contact is not on the list", async () => {
      const onText = vi.fn();
      await dispatchInbound(textEvent("text.received", "contact-blocked"), { onText }, ["contact-allowed"]);
      expect(onText).not.toHaveBeenCalled();
    });

    it("uses the first text contact for allowlist checks", async () => {
      const onText = vi.fn();
      const event = textEvent("text.received", null);
      event.data.contacts = [
        { id: "contact-blocked", name: "Blocked" },
        { id: "contact-allowed", name: "Allowed" },
      ];
      await dispatchInbound(event, { onText }, ["contact-allowed"]);
      expect(onText).not.toHaveBeenCalled();
    });

    it("supports legacy singular text contact payloads during rollout", async () => {
      const onText = vi.fn();
      await dispatchInbound(legacyTextEvent("text.received", "contact-allowed"), { onText }, ["contact-allowed"]);
      expect(onText).toHaveBeenCalledTimes(1);
    });

    it("drops iMessage when contact is not on the list", async () => {
      const onIMessage = vi.fn();
      await dispatchInbound(imessageEvent("imessage.received", "contact-blocked"), { onIMessage }, ["contact-allowed"]);
      expect(onIMessage).not.toHaveBeenCalled();
    });

    it("delivers iMessage when contact is on the list", async () => {
      const onIMessage = vi.fn();
      await dispatchInbound(imessageEvent("imessage.received", "contact-allowed"), { onIMessage }, ["contact-allowed"]);
      expect(onIMessage).toHaveBeenCalledTimes(1);
    });

    it("rejects call when contact is not on the list, ignoring handler", async () => {
      const onCall = vi.fn().mockReturnValue({ action: "answer", clientWebsocketUrl: "wss://x" });
      const result = await dispatchInbound(callEvent("contact-blocked"), { onCall }, ["contact-allowed"]);
      expect(result.callDecision).toEqual({ action: "reject" });
      expect(onCall).not.toHaveBeenCalled();
    });

    it("drops events with null contact id when an allowlist is set", async () => {
      const onMail = vi.fn();
      await dispatchInbound(mailEvent("message.received", null), { onMail }, ["contact-allowed"]);
      expect(onMail).not.toHaveBeenCalled();
    });
  });

  describe("external events", () => {
    it("classifies an unknown enveloped event_type as external and delivers it verified", async () => {
      const onExternal = vi.fn();
      const onCall = vi.fn();
      const payload = { event_type: "workflow_run.failed", title: "CI failed" };
      const result = await dispatchInbound(payload, { onExternal, onCall }, undefined, {
        requestId: "req-9",
      });
      expect(result.kind).toBe("external");
      expect(onExternal).toHaveBeenCalledWith(payload, { verified: true, requestId: "req-9" });
      // Unknown envelopes must never be guessed into the call path.
      expect(onCall).not.toHaveBeenCalled();
    });

    it("classifies a flat payload without remote_phone_number as external", async () => {
      const onExternal = vi.fn();
      const onCall = vi.fn();
      const payload = { alert: "disk full", severity: "high" };
      const result = await dispatchInbound(payload, { onExternal, onCall });
      expect(result.kind).toBe("external");
      expect(onExternal).toHaveBeenCalledTimes(1);
      expect(onCall).not.toHaveBeenCalled();
    });

    it("drops external events silently when no onExternal handler is wired", async () => {
      const onCall = vi.fn();
      const result = await dispatchInbound({ event_type: "deploy.finished" }, { onCall });
      expect(result.kind).toBe("external");
      expect(result.callDecision).toBeUndefined();
      expect(onCall).not.toHaveBeenCalled();
    });

    it("does not apply the contact allowlist to external events", async () => {
      // External senders have no Inkbox contact; their gate is the explicit
      // onExternal opt-in, not the contact allowlist.
      const onExternal = vi.fn();
      await dispatchInbound({ event_type: "deploy.finished" }, { onExternal }, ["contact-allowed"]);
      expect(onExternal).toHaveBeenCalledTimes(1);
    });

    it("still routes flat call payloads carrying remote_phone_number to onCall", async () => {
      const onExternal = vi.fn();
      const onCall = vi.fn().mockReturnValue({ action: "answer", clientWebsocketUrl: "wss://x" });
      const result = await dispatchInbound(callEvent(), { onExternal, onCall });
      expect(result.kind).toBe("call");
      expect(onExternal).not.toHaveBeenCalled();
    });
  });
});
