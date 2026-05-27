import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { registerContactRuleTools } from "../../src/tools/contact-rules.js";

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

function createRuntime(params: {
  identity?: any;
  mailContactRules?: Record<string, ReturnType<typeof vi.fn>>;
  phoneContactRules?: Record<string, ReturnType<typeof vi.fn>>;
}): InkboxRuntime {
  return {
    getIdentity: () => Promise.resolve(params.identity ?? {}),
    getClient: () =>
      Promise.resolve({
        mailContactRules: params.mailContactRules ?? {},
        phoneContactRules: params.phoneContactRules ?? {},
      } as any),
  };
}

describe("registerContactRuleTools", () => {
  it("creates mailbox allow/block rules for the configured mailbox", async () => {
    const { api, tools, options } = createApi();
    const create = vi.fn().mockResolvedValue({ id: "rule-1" });
    registerContactRuleTools(
      api,
      createRuntime({
        identity: { mailbox: { emailAddress: "agent@inkboxmail.com" } },
        mailContactRules: { create },
      }),
    );

    const out = await tools.get("inkbox_create_mail_contact_rule")!.execute("turn-1", {
      action: "block",
      matchType: "domain",
      matchTarget: "spam.example",
    });

    expect(options.get("inkbox_create_mail_contact_rule")).toEqual({ optional: true });
    expect(create).toHaveBeenCalledWith("agent@inkboxmail.com", {
      action: "block",
      matchType: "domain",
      matchTarget: "spam.example",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Created mail contact rule id=rule-1");
  });

  it("lists phone rules for the configured phone number id", async () => {
    const { api, tools } = createApi();
    const list = vi.fn().mockResolvedValue([{ id: "phone-rule-1" }]);
    registerContactRuleTools(
      api,
      createRuntime({
        identity: { phoneNumber: { id: "phone-1" } },
        phoneContactRules: { list },
      }),
    );

    const out = await tools.get("inkbox_list_phone_contact_rules")!.execute("turn-1", {
      action: "allow",
      limit: 10,
    });

    expect(list).toHaveBeenCalledWith("phone-1", {
      action: "allow",
      matchType: undefined,
      limit: 10,
      offset: 0,
    });
    expect(out.content[0].text).toContain("Returned 1 phone rule(s).");
  });

  it("returns a tool error when phone rules are requested without a phone number", async () => {
    const { api, tools } = createApi();
    registerContactRuleTools(api, createRuntime({ identity: {} }));

    const out = await tools.get("inkbox_delete_phone_contact_rule")!.execute("turn-1", {
      ruleId: "rule-1",
    });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("has no phone number");
  });
});
