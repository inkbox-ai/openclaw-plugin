import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { canonicalInkboxSessionOverride } from "../../src/session-key.js";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;

async function storageValidator(): Promise<(key: string, agentId?: string) => void> {
  const files = readdirSync(hostDist).filter((file) =>
    file.startsWith("session-accessor.sqlite-transcript-state-") && file.endsWith(".js"),
  );
  expect(files, "The latest host must expose its canonical storage-key validator").toHaveLength(1);
  const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
  const validate = Object.values(exports).find((value) =>
    typeof value === "function" && value.name === "assertCanonicalSessionKeyWrite",
  );
  expect(validate).toBeTypeOf("function");
  return validate as (key: string, agentId?: string) => void;
}

function scoped(raw: string, agentId = "worker") {
  return canonicalInkboxSessionOverride(agentId, raw);
}

describe("actual host A2A session-key contract", () => {
  it("keeps task contexts, progress sessions, and agents distinct", () => {
    const keys = [
      scoped("a2a:identity:context-one"),
      scoped("a2a:identity:context-two"),
      scoped("a2a-progress:identity:task-one"),
      scoped("a2a:identity:context-one", "another-worker"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(parseAgentSessionKey(keys[0])?.agentId).toBe("worker");
    expect(parseAgentSessionKey(keys[3])?.agentId).toBe("another-worker");
  });

  it("normalizes canonical keys without changing their owner or wrapping twice", () => {
    const key = scoped("a2a:identity:context-one");
    expect(scoped(key)).toBe(key);
    expect(scoped(` ${key.toUpperCase()} `)).toBe(key);
    expect(scoped(key, "another-worker")).toBe(key);
    expect(scoped("global")).toBe("global");
    expect(scoped("unknown")).toBe("unknown");
  });

  // The minimum supported May host predates canonical SQLite writes. Do not
  // skip missing validators on later hosts: that is a latest-host CI contract.
  it.skipIf(hostVersion === "2026.5.27")(
    "reproduces rejected raw A2A keys and accepts their agent-scoped form", async () => {
      const validate = await storageValidator();
      for (const raw of ["a2a:identity:context-one", "a2a-progress:identity:task-one"]) {
        expect(() => validate(raw, "worker")).toThrow("non-canonical session key");
        expect(() => validate(scoped(raw), "worker")).not.toThrow();
        expect(() => validate(scoped(raw), "another-worker")).toThrow("non-canonical session key");
      }
    },
  );
});
