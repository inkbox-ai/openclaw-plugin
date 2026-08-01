// End-to-end drive of the REAL runSetupWizard entry: a scripted prompter and
// a fake Inkbox client walk the whole flow (auth -> avatar -> iMessage ->
// dedicated number -> realtime -> signing key -> delivery -> persist) and the
// tests assert cross-step ORDERING and continuation, not just unit behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupWizard } from "../src/setup-wizard.js";
import type { Prompter } from "../src/prompt.js";

const sdk = vi.hoisted(() => {
  class MockInkboxAPIError extends Error {
    statusCode: number;
    detail: unknown;

    constructor(statusCode: number, detail: unknown) {
      super(typeof detail === "string" ? detail : JSON.stringify(detail));
      this.statusCode = statusCode;
      this.detail = detail;
    }
  }

  // The wizard constructs Inkbox twice on the admin path (pasted admin key,
  // then the minted agent key); route every construction to a swappable
  // factory so one shared fake client backs both.
  const clientFactory: { current: () => unknown } = {
    current: () => {
      throw new Error("clientFactory not initialized by the test");
    },
  };
  const Inkbox = Object.assign(
    vi.fn(() => clientFactory.current()),
    {
      signup: vi.fn(),
      verifySignup: vi.fn(),
    },
  );
  return { Inkbox, InkboxAPIError: MockInkboxAPIError, clientFactory };
});

vi.mock("@inkbox/sdk", () => ({
  Inkbox: sdk.Inkbox,
  InkboxAPIError: sdk.InkboxAPIError,
  AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED: "admin",
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED: "agent_claimed",
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED: "agent_unclaimed",
}));

// Scripted prompter: answers are matched by question substring so the drive
// stays readable and order-independent; every prompt is recorded for the
// "was this ever asked?" assertions.
interface ScriptedPrompter extends Prompter {
  confirmsAsked: string[];
  asksAsked: string[];
  selectsAsked: string[];
}

function scriptedPrompter(script: {
  confirms?: Array<[match: string, answer: boolean]>;
  asks?: Array<[match: string, answer: string]>;
  selects?: Array<[match: string, answer: string]>;
}): ScriptedPrompter {
  const confirmsAsked: string[] = [];
  const asksAsked: string[] = [];
  const selectsAsked: string[] = [];
  return {
    confirmsAsked,
    asksAsked,
    selectsAsked,
    confirm: async (question: string, defaultYes?: boolean) => {
      confirmsAsked.push(question);
      const hit = script.confirms?.find(([match]) => question.includes(match));
      return hit ? hit[1] : Boolean(defaultYes);
    },
    ask: async (question: string, defaultValue?: string) => {
      asksAsked.push(question);
      const hit = script.asks?.find(([match]) => question.includes(match));
      return hit ? hit[1] : (defaultValue ?? "");
    },
    select: async (question: string, _options: any[], defaultValue?: string) => {
      selectsAsked.push(question);
      const hit = script.selects?.find(([match]) => question.includes(match));
      if (hit) return hit[1] as any;
      const legacy = script.confirms?.find(([match]) =>
        "Use OpenAI Realtime API for phone calls?".includes(match),
      );
      confirmsAsked.push("Use OpenAI Realtime API for phone calls?");
      return (legacy?.[1] ? "openai_realtime" : defaultValue ?? "inkbox_tts_stt") as any;
    },
    close: () => {},
  };
}

// One fake Inkbox world per scenario: a single identity plus a client whose
// channel operations append to `events` so tests can compare step indices.
function makeWorld(options: {
  hasPhone?: boolean;
  imessageAlreadyEnabled?: boolean;
  provisionError?: unknown;
} = {}) {
  const events: string[] = [];
  const phone = {
    id: "phone-1",
    number: "+15550001111",
    type: "local",
    smsStatus: "ready",
  };

  const identity: any = {
    id: "identity-1",
    agentHandle: "drive-agent",
    displayName: "Drive Agent",
    emailAddress: "drive-agent@inkboxmail.com",
    mailbox: { id: "mailbox-1", emailAddress: "drive-agent@inkboxmail.com" },
    phoneNumber: options.hasPhone ? { ...phone } : null,
    imessageEnabled: Boolean(options.imessageAlreadyEnabled),
    tunnel: { publicHost: "drive-agent.inkboxwire.com" },
    update: vi.fn(async (patch: { imessageEnabled?: boolean }) => {
      if (patch.imessageEnabled) {
        events.push("imessage:enable");
        identity.imessageEnabled = true;
      }
      return identity;
    }),
    provisionPhoneNumber: vi.fn(async () => {
      events.push("dedicated:provision");
      if (options.provisionError) {
        throw options.provisionError;
      }
      identity.phoneNumber = { ...phone };
      return identity.phoneNumber;
    }),
    refresh: vi.fn(async () => identity),
    // Immediate START opt-in so the post-provision poll exits on pass one.
    listTexts: vi.fn(async () => [{ direction: "inbound", text: "START" }]),
    listIMessageAssignments: vi.fn(async () => []),
    listIMessages: vi.fn(async () => []),
    sendIMessage: vi.fn(async () => ({ id: "im-1" })),
    markIMessageConversationRead: vi.fn(async () => ({})),
    setIncomingCallAction: vi.fn(async () => {
      events.push("delivery:call-config");
      return {};
    }),
  };

  const client: any = {
    whoami: vi.fn(),
    listIdentities: vi.fn(async () => [{ agentHandle: identity.agentHandle }]),
    getIdentity: vi.fn(async () => identity),
    createIdentity: vi.fn(async () => {
      events.push("identity:create");
      return identity;
    }),
    apiKeys: { create: vi.fn(async () => ({ apiKey: "ApiKey_minted_agent" })) },
    createSigningKey: vi.fn(async () => {
      events.push("signing-key:create");
      return { signingKey: "whsec_drive" };
    }),
    phoneNumbers: { update: vi.fn(async () => ({})) },
    imessages: {
      getTriageNumber: vi.fn(async () => ({
        number: "+15550009999",
        connectCommand: "connect @drive-agent",
      })),
    },
    webhooks: {
      subscriptions: {
        list: vi.fn(async () => []),
        create: vi.fn(async (opts: any) => {
          events.push(`delivery:subscribe:${opts.eventTypes[0].split(".")[0]}`);
          return {
            id: "sub-1",
            url: opts.url,
            eventTypes: opts.eventTypes,
            status: "active",
          };
        }),
        update: vi.fn(async () => ({})),
      },
    },
  };
  client.whoami.mockResolvedValue({
    authType: "api_key",
    authSubtype: "agent_claimed",
    organizationId: "org-1",
  });
  sdk.clientFactory.current = () => client;

  return { events, identity, client };
}

// Baseline prompt script: paste an agent key, enable iMessage, skip the
// iPhone connect wait, provision a number, decline OpenAI Realtime, and
// generate a signing key (default-yes answers cover the rest).
const baseConfirms: Array<[string, boolean]> = [
  ["Do you already have an Inkbox API key?", true],
  ["Enable iMessage for this agent?", true],
  ["Connect your iPhone to this agent now?", false],
  ["Provision a dedicated phone number now?", true],
  ["Use OpenAI Realtime API for phone calls?", false],
  ["Do you already have a webhook signing key to keep using?", false],
  ["Generate/rotate the org webhook signing key now?", true],
];
const baseAsks: Array<[string, string]> = [
  ["Paste your Inkbox API key", "ApiKey_drive"],
];

let tempHome: string;
let logLines: string[];

function output(): string {
  return logLines.join("\n");
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-drive-test-"));
  vi.stubEnv("HOME", tempHome);
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  // Avatar probe: pretend the identity already has one so the step no-ops.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(tempHome, { recursive: true, force: true });
});

describe("setup wizard end-to-end drive", () => {
  it("walks channels in order: iMessage before the dedicated number, with the voice-calls intro", async () => {
    const world = makeWorld();
    const prompter = scriptedPrompter({ confirms: baseConfirms, asks: baseAsks });

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
    });

    // (f) whole entry completes cleanly.
    expect(result.ok).toBe(true);

    // (a) iMessage enablement fires strictly before dedicated-number provisioning.
    const imessageAt = world.events.indexOf("imessage:enable");
    const dedicatedAt = world.events.indexOf("dedicated:provision");
    expect(imessageAt).toBeGreaterThanOrEqual(0);
    expect(dedicatedAt).toBeGreaterThanOrEqual(0);
    expect(imessageAt).toBeLessThan(dedicatedAt);

    // (b) the iMessage intro carries the ported voice-calls copy.
    expect(output()).toContain("make and take voice calls");

    // (e) the explicit voice-stack selector is offered once a call channel exists.
    expect(prompter.selectsAsked).toContain("Choose how this agent should handle phone calls");

    // Continuation proof: signing key and inbound delivery ran after channels.
    expect(world.events).toContain("signing-key:create");
    expect(world.events).toContain("delivery:call-config");
    expect(world.events.indexOf("signing-key:create")).toBeGreaterThan(dedicatedAt);
    expect(result.config).toMatchObject({
      apiKey: "ApiKey_drive",
      identity: "drive-agent",
      signingKey: "whsec_drive",
    });
  });

  it("says 'Already provisioned' and never prompts to provision when a number exists", async () => {
    const world = makeWorld({ hasPhone: true, imessageAlreadyEnabled: true });
    const prompter = scriptedPrompter({
      confirms: baseConfirms,
      asks: baseAsks,
    });

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    // (c) the step announces itself instead of silently skipping...
    expect(output()).toContain("Already provisioned: +15550001111");
    // ...and no provisioning prompt or API call fires.
    expect(
      prompter.confirmsAsked.some((q) => q.includes("Provision a dedicated phone number")),
    ).toBe(false);
    expect(world.identity.provisionPhoneNumber).not.toHaveBeenCalled();
  });

  it("falls back to the paid-tier pricing note on provision failure and keeps going", async () => {
    const world = makeWorld({
      provisionError: new sdk.InkboxAPIError(403, "phone provisioning requires a paid plan"),
    });
    const prompter = scriptedPrompter({ confirms: baseConfirms, asks: baseAsks });

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
    });

    // (d) pricing fallback printed, wizard continued to later steps, no throw.
    expect(output()).toContain("https://inkbox.ai/pricing");
    expect(result.ok).toBe(true);
    expect(world.events).toContain("signing-key:create");
    // iMessage stayed enabled, so realtime is still offered and inbound
    // delivery still registers the shared-line call bridge + imessage sub.
    expect(
      prompter.confirmsAsked.some((q) => q.includes("Use OpenAI Realtime API")),
    ).toBe(true);
    expect(world.events).toContain("delivery:subscribe:imessage");
    expect(world.events).toContain("delivery:call-config");
  });

  it("skips the realtime offer entirely when there is no number and no iMessage", async () => {
    const world = makeWorld();
    const prompter = scriptedPrompter({
      confirms: [
        ["Do you already have an Inkbox API key?", true],
        ["Enable iMessage for this agent?", false],
        ["Provision a dedicated phone number now?", false],
        ["Do you already have a webhook signing key to keep using?", false],
        ["Generate/rotate the org webhook signing key now?", true],
      ],
      asks: baseAsks,
    });

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    // (e) no call channel -> the realtime step never fires.
    expect(
      prompter.confirmsAsked.some((q) => q.includes("Use OpenAI Realtime API")),
    ).toBe(false);
    expect(result.config?.voiceRealtime).toBeUndefined();
    expect(world.events).not.toContain("imessage:enable");
    expect(world.events).not.toContain("dedicated:provision");
    expect(world.events).toContain("signing-key:create");
  });

  it("enables realtime with a validated key when the operator opts in", async () => {
    makeWorld();
    const prompter = scriptedPrompter({
      confirms: [...baseConfirms.filter(([m]) => !m.includes("Realtime")), [
        "Use OpenAI Realtime API for phone calls?",
        true,
      ]],
      asks: [...baseAsks, ["Paste your OpenAI API key", "sk-drive-realtime"]],
    });
    const validate = vi.fn(async () => ({ ok: true as const }));

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
      validateOpenAiRealtimeApiKey: validate,
    });

    expect(result.ok).toBe(true);
    expect(validate).toHaveBeenCalledWith("sk-drive-realtime", "gpt-realtime-2");
    expect(result.config?.voiceRealtime).toMatchObject({
      enabled: true,
      provider: "openai",
    });
  });

  it("keeps the channel ordering on the admin-scoped fresh-identity path", async () => {
    const world = makeWorld();
    world.client.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "admin",
      organizationId: "org-1",
    });
    world.client.listIdentities.mockResolvedValue([]);
    // Fresh identity -> avatar upload path (PUT) instead of the has-avatar probe.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 201 })));
    const prompter = scriptedPrompter({
      confirms: baseConfirms,
      asks: [
        ...baseAsks,
        ["New identity handle", "drive-agent"],
        ["Display name (optional)", "Drive Agent"],
      ],
    });

    const result = await runSetupWizard({
      prompter,
      env: { HOME: tempHome } as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    // Fresh identity was created, then channels ran in the reordered sequence.
    const createdAt = world.events.indexOf("identity:create");
    const imessageAt = world.events.indexOf("imessage:enable");
    const dedicatedAt = world.events.indexOf("dedicated:provision");
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(imessageAt).toBeGreaterThan(createdAt);
    expect(dedicatedAt).toBeGreaterThan(imessageAt);
    // The plugin config carries the minted agent-scoped key, not the admin key.
    expect(result.config?.apiKey).toBe("ApiKey_minted_agent");
  });
});
