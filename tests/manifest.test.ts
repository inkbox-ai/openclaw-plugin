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

function collectRuntimeTools(): {
  toolNames: string[];
  optionalToolNames: string[];
} {
  const tools: string[] = [];
  const optionalTools: string[] = [];
  const api = {
    registrationMode: "tool-discovery",
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
    registerTool(definition: { name: string }, options?: { optional?: boolean }) {
      tools.push(definition.name);
      if (options?.optional === true) {
        optionalTools.push(definition.name);
      }
    },
  };

  entry.register(api as any);
  return {
    toolNames: [...tools].sort(),
    optionalToolNames: [...optionalTools].sort(),
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
