import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import {
  inkboxAccountConfigJsonSchema,
  inkboxChannelConfigSchema,
} from "../src/config-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "openclaw.plugin.json"), "utf8"),
) as any;

function sortedKeys(value: { properties?: Record<string, unknown> }): string[] {
  return Object.keys(value.properties ?? {}).sort();
}

function collectRuntimeTools(registrationMode = "tool-discovery"): {
  toolNames: string[];
  optionalToolNames: string[];
  hookNames: string[];
} {
  const tools: string[] = [];
  const optionalTools: string[] = [];
  const hookNames: string[] = [];
  const api = {
    registrationMode,
    registerChannel: vi.fn(),
    pluginConfig: {
      apiKey: "ApiKey_test",
      identity: "smoke-agent",
    },
    runtime: {
      config: { current: () => ({}) },
      channel: { runtimeContexts: { get: () => undefined } },
    },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    on(name: string) {
      hookNames.push(name);
    },
    registerTool(
      definition: { name: string } | ((context: unknown) => unknown),
      options?: { optional?: boolean; names?: string[] },
    ) {
      const names =
        typeof definition === "function"
          ? (options?.names ?? [])
          : [definition.name];
      tools.push(...names);
      if (options?.optional === true) {
        optionalTools.push(...names);
      }
    },
  };

  entry.register(api as any);
  return {
    toolNames: [...tools].sort(),
    optionalToolNames: [...optionalTools].sort(),
    hookNames: [...hookNames].sort(),
  };
}

describe("openclaw.plugin.json manifest parity", () => {
  it("declares the same tool contract and optional metadata as runtime registration", () => {
    const runtime = collectRuntimeTools();

    expect([...manifest.contracts.tools].sort()).toEqual(runtime.toolNames);
    expect(
      Object.entries(manifest.toolMetadata ?? {})
        .filter(([, metadata]: [string, any]) => metadata?.optional === true)
        .map(([name]) => name)
        .sort(),
    ).toEqual(runtime.optionalToolNames);
  });

  it.each(["full", "discovery", "tool-discovery"])("registers settlement hooks once in the host %s registry", (mode) => {
    expect(collectRuntimeTools(mode).hookNames).toEqual([
      "after_tool_call",
      "after_tool_call",
      "before_agent_run",
      "before_tool_call",
      "message_sending",
      "model_call_ended",
      "model_call_started",
    ]);
  });

  it("keeps discovery free of tools and skips hooks in setup-only and CLI modes", () => {
    expect(collectRuntimeTools("discovery").toolNames).toEqual([]);
    for (const mode of ["cli-metadata", "setup-only", "setup-runtime"]) {
      expect(collectRuntimeTools(mode).hookNames).toEqual([]);
    }
  });

  it("keeps static config schemas aligned with source config-schema.ts", () => {
    const accountSchema = inkboxAccountConfigJsonSchema as any;
    const channelSchema = inkboxChannelConfigSchema.schema as any;
    const manifestChannelSchema = manifest.channelConfigs.inkbox.schema;
    const manifestAccountSchema =
      manifestChannelSchema.properties.accounts.additionalProperties;
    const manifestPluginSchema = manifest.configSchema;

    expect(sortedKeys(manifestChannelSchema)).toEqual(sortedKeys(channelSchema));
    expect(sortedKeys(manifestAccountSchema)).toEqual(sortedKeys(accountSchema));
    expect(sortedKeys(manifestPluginSchema)).toEqual(sortedKeys(accountSchema));

    for (const key of ["sms", "vault", "voiceRealtime"]) {
      expect(sortedKeys(manifestChannelSchema.properties[key])).toEqual(
        sortedKeys(accountSchema.properties[key]),
      );
      expect(sortedKeys(manifestAccountSchema.properties[key])).toEqual(
        sortedKeys(accountSchema.properties[key]),
      );
      expect(sortedKeys(manifestPluginSchema.properties[key])).toEqual(
        sortedKeys(accountSchema.properties[key]),
      );
    }
  });
});
