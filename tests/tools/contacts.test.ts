import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { registerContactTools } from "../../src/tools/contacts.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): {
  api: any;
  tools: Map<string, RegisteredTool>;
  options: Map<string, any>;
} {
  const tools = new Map<string, RegisteredTool>();
  const options = new Map<string, any>();
  const api = {
    registerTool: (def: RegisteredTool, opts?: any) => {
      tools.set(def.name, def);
      options.set(def.name, opts);
    },
  };
  return { api, tools, options };
}

function createMockRuntime(contacts: Record<string, ReturnType<typeof vi.fn>>): InkboxRuntime {
  return {
    getIdentity: () => Promise.resolve({} as any),
    getClient: () => Promise.resolve({ contacts } as any),
  };
}

describe("registerContactTools", () => {
  it("creates Inkbox contacts with normalized email and phone entries", async () => {
    const { api, tools, options } = createApi();
    const create = vi.fn().mockResolvedValue({
      id: "contact-1",
      preferredName: "Dima",
      emails: [],
      phones: [],
    });
    registerContactTools(api, createMockRuntime({ create }));

    const out = await tools.get("inkbox_create_contact")!.execute("turn-1", {
      preferredName: "Dima",
      notes: "saved from SMS",
      emails: [{ value: "dima@example.com", label: "work", isPrimary: true }],
      phones: [{ value: "+15551234567", label: "mobile" }],
    });

    expect(options.get("inkbox_create_contact")).toBeUndefined();
    expect(create).toHaveBeenCalledWith({
      preferredName: "Dima",
      notes: "saved from SMS",
      emails: [{ value: "dima@example.com", label: "work", isPrimary: true }],
      phones: [{ value: "+15551234567", label: "mobile", isPrimary: false }],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Created contact id=contact-1");
  });

  it("updates contacts and lets callers clear email or phone lists", async () => {
    const { api, tools, options } = createApi();
    const update = vi.fn().mockResolvedValue({
      id: "contact-1",
      preferredName: "Dima",
      emails: [],
      phones: [],
    });
    registerContactTools(api, createMockRuntime({ update }));

    const out = await tools.get("inkbox_update_contact")!.execute("turn-1", {
      contactId: "contact-1",
      notes: null,
      emails: null,
      phones: [{ value: "+15551234567", isPrimary: true }],
    });

    expect(options.get("inkbox_update_contact")).toEqual({ optional: true });
    expect(update).toHaveBeenCalledWith("contact-1", {
      notes: null,
      emails: null,
      phones: [{ value: "+15551234567", label: null, isPrimary: true }],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Updated contact id=contact-1");
  });

  it("registers destructive contact delete as optional", async () => {
    const { api, tools, options } = createApi();
    const deleteContact = vi.fn().mockResolvedValue(undefined);
    registerContactTools(api, createMockRuntime({ delete: deleteContact }));

    const out = await tools.get("inkbox_delete_contact")!.execute("turn-1", {
      contactId: "contact-1",
    });

    expect(options.get("inkbox_delete_contact")).toEqual({ optional: true });
    expect(deleteContact).toHaveBeenCalledWith("contact-1");
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Deleted contact contact-1");
  });
});
