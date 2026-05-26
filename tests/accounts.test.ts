import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  listInkboxAccountIds,
  resolveInkboxAccount,
} from "../src/accounts.js";

describe("inkbox account config", () => {
  it("falls back to plugin-scoped config for the default account", () => {
    const account = resolveInkboxAccount({
      cfg: {
        plugins: {
          entries: {
            inkbox: {
              config: {
                apiKey: "ApiKey_plugin",
                identity: "plugin-agent",
                signingKey: "sign_plugin",
                voiceTranscriptCoalesceMs: 900,
                voiceAgentPrewarm: false,
                voiceAgentPrewarmTtlMs: 120000,
                voiceAgentPrewarmTimeoutMs: 45000,
                voiceRealtime: {
                  enabled: true,
                  provider: "openai",
                  model: "gpt-realtime",
                  voice: "cedar",
                  toolPolicy: "owner",
                  consultPolicy: "substantive",
                  providers: {
                    openai: {
                      apiKey: "${OPENAI_API_KEY}",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.configured).toBe(true);
    expect(account.apiKey).toBe("ApiKey_plugin");
    expect(account.identity).toBe("plugin-agent");
    expect(account.signingKey).toBe("sign_plugin");
    expect(account.config.voiceTranscriptCoalesceMs).toBe(900);
    expect(account.config.voiceAgentPrewarm).toBe(false);
    expect(account.config.voiceAgentPrewarmTtlMs).toBe(120000);
    expect(account.config.voiceAgentPrewarmTimeoutMs).toBe(45000);
    expect(account.config.voiceRealtime).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-realtime",
      voice: "cedar",
      toolPolicy: "owner",
      consultPolicy: "substantive",
      providers: {
        openai: {
          apiKey: "${OPENAI_API_KEY}",
        },
      },
    });
  });

  it("lets channel account config override plugin config", () => {
    const cfg = {
      plugins: {
        entries: {
          inkbox: {
            config: {
              apiKey: "ApiKey_plugin",
              identity: "plugin-agent",
            },
          },
        },
      },
      channels: {
        inkbox: {
          defaultAccount: "work",
          apiKey: "ApiKey_shared",
          accounts: {
            work: {
              identity: "work-agent",
              signingKey: "sign_work",
            },
          },
        },
      },
    };

    expect(listInkboxAccountIds(cfg)).toEqual(["work"]);
    const account = resolveInkboxAccount({ cfg, accountId: "work" });
    expect(account.configured).toBe(true);
    expect(account.apiKey).toBe("ApiKey_shared");
    expect(account.identity).toBe("work-agent");
    expect(account.signingKey).toBe("sign_work");
  });
});
