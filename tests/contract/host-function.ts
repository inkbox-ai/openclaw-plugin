import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
let definitions: Map<string, Set<string>> | undefined;

export async function hostFunction(name: string): Promise<any> {
  // Chunk names change when the host reorganizes its build. Require a unique
  // declaration and its real export, not a particular generated filename.
  if (!definitions) {
    definitions = new Map();
    for (const file of readdirSync(hostDist)) {
      if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
      const source = readFileSync(join(hostDist, file), "utf8");
      for (const match of source.matchAll(/\bfunction\s+([\w$]+)\s*\(/g)) {
        const files = definitions.get(match[1]) ?? new Set<string>();
        files.add(file);
        definitions.set(match[1], files);
      }
    }
  }
  const files = [...(definitions.get(name) ?? [])];
  expect(files, `Expected one host definition of ${name}`).toHaveLength(1);
  const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
  const functions = Object.values(exports).filter(
    (value) => typeof value === "function" && value.name === name,
  );
  expect(functions, `Expected one host export of ${name}`).toHaveLength(1);
  return functions[0];
}
