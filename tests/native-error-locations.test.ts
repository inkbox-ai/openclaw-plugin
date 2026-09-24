import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateShapes, LIMITS, locateNativeErrors, nativeErrors, sourceTemplates } from "./ci/native_error_locations.mjs";

const roots: string[] = [];
const rootRecord = (message: string, extra = {}) => JSON.stringify({ level: "error", message: `Embedded agent failed before reply: ${message}`, ...extra });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CI native error source candidates", () => {
  it("only reads bounded native root error records, not prompt or subsystem prose", () => {
    const log = [rootRecord("native error"), rootRecord("private prompt", { subsystem: "agent/embedded" }),
      rootRecord("not an error", { level: "info" }), "malformed", "null", "[]", rootRecord("x".repeat(LIMITS.recordBytes)),
      JSON.stringify({ level: "error", message: "unrelated private message" })].join("\n");
    expect(nativeErrors(log)).toEqual(["native error"]);
    expect(nativeErrors(Array.from({ length: 25 }, (_, i) => rootRecord(`failure${i}`)).join("\n"))).toHaveLength(20);
  });

  it("catalogues Error constructors, not comments or unrelated source strings", () => {
    const source = '// new Error("Private comment is not an error construction");\n'
      + 'const prose = "A private arbitrary source string is not an error";\n'
      + 'throw new Error("Session prompt preparation is stale after replacement or disposal.");\n';
    const templates = sourceTemplates(source, "resource-loader-abc.mjs");
    expect(templates).toHaveLength(1);
    expect(candidateShapes(["Session prompt preparation is stale after replacement or disposal."], templates))
      .toEqual(["native_error_candidate source=resource-loader-abc.mjs:3 kind=literal"]);
  });

  it("matches native template segments without revealing private substitutions", () => {
    const source = 'throw new PreparedModelRuntimePublicationSupersededError(`prepared model runtime publication was superseded for ${input.agentDir}`);';
    const shapes = candidateShapes(["prepared model runtime publication was superseded for /secret/agent/identity"], sourceTemplates(source, "prepared-model-runtime.errors-abc.mjs"));
    expect(shapes).toEqual(["native_error_candidate source=prepared-model-runtime.errors-abc.mjs:1 kind=template"]);
    expect(shapes.join()).not.toMatch(/secret|identity|publication/);
  });

  it("matches native formatted cause chains without projecting private wrapper text", () => {
    const message = "Session prompt preparation is stale after replacement or disposal.";
    const templates = sourceTemplates(`throw new Error(${JSON.stringify(message)});`, "resource-loader-abc.mjs");
    const errors = nativeErrors(rootRecord(`/private/outer-error | ${message} | private-code`));
    expect(candidateShapes(errors, templates)).toEqual(["native_error_candidate source=resource-loader-abc.mjs:1 kind=literal"]);
    expect(candidateShapes(errors, templates).join()).not.toContain("private");
  });

  it("requires anchored ordered segments and ignores catch-all/short templates", () => {
    const source = 'new Error(`Authentication failed for "${provider}". Run login for ${provider} to re-authenticate.`);\n'
      + 'new Error(`${secret}`); new Error(`Oops ${secret}`);';
    const templates = sourceTemplates(source, "auth-abc.js");
    expect(templates).toHaveLength(1);
    expect(candidateShapes(['Authentication failed for "private". Run login for private to re-authenticate.'], templates)[0]).toContain("kind=template");
    for (const value of ['prefix Authentication failed for "private". Run login for private to re-authenticate.',
      'Authentication failed for "private". Run login for private to re-authenticate. suffix',
      'Authentication failed for "private". to re-authenticate.']) {
      expect(candidateShapes([value], templates)).toEqual(["native_error_candidates=none"]);
    }
  });

  it("follows only same-file direct message-factory returns without executing them", () => {
    const source = 'function formatNoApiKeyFoundMessage(provider) { return `No API key found for ${provider}. Run login to continue.`; }\n'
      + 'function unrelated() { return "Private data should not appear in the source catalogue"; }\n'
      + 'throw new Error(formatNoApiKeyFoundMessage(provider));';
    const templates = sourceTemplates(source, "resource-loader-abc.mjs");
    expect(templates).toHaveLength(1);
    expect(candidateShapes(["No API key found for private-provider. Run login to continue."], templates))
      .toEqual(["native_error_candidate source=resource-loader-abc.mjs:1 kind=template"]);
  });

  it("prefers exact literals, deduplicates and explicitly bounds ambiguous candidates", () => {
    const source = 'throw new Error("The native error is a synthetic fixture only");';
    const templates = Array.from({ length: 12 }, (_, i) => sourceTemplates(source, `fixture-${i}.mjs`)).flat();
    templates.unshift(...sourceTemplates('throw new Error(`The native error is ${detail}`);', "a-template.mjs"));
    templates.push(...templates);
    const result = candidateShapes(["The native error is a synthetic fixture only"], templates);
    expect(result).toHaveLength(11);
    expect(result.slice(0, 10).every((shape: string) => shape.endsWith("kind=literal"))).toBe(true);
    expect(result.at(-1)).toBe("native_error_candidates=bounded");
    expect(sourceTemplates(source, "../../private-name.mjs")).toEqual([]);
  });

  async function fixture(name = "openclaw") {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-location-test-"));
    roots.push(root);
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name }));
    await writeFile(path.join(root, "openclaw.mjs"), "// fixture only");
    await writeFile(path.join(root, "gateway.log"), rootRecord("Session prompt preparation is stale after replacement or disposal."));
    await writeFile(path.join(root, "dist", "resource-loader-abc.mjs"), 'throw new Error("Session prompt preparation is stale after replacement or disposal.");');
    return { root, executable: path.join(root, "openclaw.mjs"), logPath: path.join(root, "gateway.log") };
  }

  it("verifies the installed package and emits only its safe source basename/line", async () => {
    const input = await fixture();
    expect(await locateNativeErrors(input)).toEqual(["native_error_candidate source=resource-loader-abc.mjs:1 kind=literal"]);
    const wrongPackage = await fixture("private-package");
    expect(await locateNativeErrors(wrongPackage)).toEqual(["native_error_candidates=unavailable"]);
    expect(await locateNativeErrors({ executable: "/secret/missing", logPath: "/secret/missing" }))
      .toEqual(["native_error_candidates=unavailable"]);
  });

  it("does not report a false no-match when the installed catalogue exceeds a bound", async () => {
    const input = await fixture();
    await writeFile(path.join(input.root, "dist", "large.mjs"), " ".repeat(LIMITS.fileBytes + 1));
    expect(await locateNativeErrors(input)).toEqual(["native_error_candidates=catalog_bounded"]);
  });

  it("reads only the bounded log tail and does not interpret a truncated record", async () => {
    const input = await fixture();
    await writeFile(input.logPath, rootRecord("Session prompt preparation is stale after replacement or disposal.") + "\n" + " ".repeat(LIMITS.logBytes + 1));
    expect(await locateNativeErrors(input)).toEqual(["native_error_candidates=no_records"]);
  });
});
