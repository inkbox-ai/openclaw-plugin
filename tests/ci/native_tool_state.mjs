// Temporary CI-only observation of native tool assembly. No tool names, paths,
// configuration values, errors, or message content are written to the log.
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const KEY = "inkbox.ciNativeToolState.v1";
const MARKER = "__inkboxCiToolAssembly";
const MAX_RECORDS = 200;
const FLAGS = ["selected", "snapshot", "scoped", "index", "enabled", "ordered", "owner", "complete", "cold"];
const COUNTS = ["registrations", "returned"];
const bool = (value) => typeof value === "boolean" ? String(value) : "unknown";
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? String(Math.min(value, 9999)) : "unknown";
const ERROR_CODES = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM", "ENOENT", "ENOSPC", "EACCES", "EPERM", "OC_DOCTOR_DUPLICATE_CHECK"]);

export function projectLoadedPlugin(ordinal, record, diagnostics, complete) {
  const state = record == null ? "absent" : ["loaded", "disabled", "error"].includes(record.status) ? record.status : "unknown";
  const phase = ["validation", "load", "register"].includes(record?.failurePhase) ? record.failurePhase : "unknown";
  const relevant = Array.isArray(diagnostics) ? diagnostics.filter((entry) => entry?.pluginId === "inkbox") : [];
  const code = relevant.find((entry) => ERROR_CODES.has(entry.errorCode))?.errorCode ?? "unknown";
  return `native_plugin_load assembly=${count(ordinal)} state=${state} phase=${phase} complete=${bool(complete)} ` +
    `declared=${count(record?.contracts?.tools?.length)} names=${count(record?.toolNames?.length)} ` +
    `errors=${count(relevant.filter((entry) => entry.level === "error").length)} ` +
    `warnings=${count(relevant.filter((entry) => entry.level === "warn").length)} code=${code} ` +
    `sdk_incompatible=${relevant.some((entry) => entry.code === "sdk-incompatible")}`;
}

export function projectToolState(phase, ordinal, values) {
  if (!["owner", "loaded", "result"].includes(phase)) return undefined;
  return `native_tool_probe phase=${phase} assembly=${count(ordinal)} ` +
    [...FLAGS.map((key) => `${key}=${bool(values?.[key])}`),
      ...COUNTS.map((key) => `${key}=${count(values?.[key])}`)].join(" ");
}

function observation(phase, expression) {
  // Keep projection and every observed getter inside the exception boundary.
  return `\n\ttry { globalThis[Symbol.for(${JSON.stringify(KEY)})]?.emit(${JSON.stringify(phase)}, ${MARKER}, ${expression}); } catch {}\n`;
}

export function instrumentToolState(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 4 * 1024 * 1024 || source.includes(MARKER)) return undefined;
  const start = "function resolvePluginToolsFromRegistry(params, loadState) {";
  const missing = "\n\tif (missingPluginIds.length > 0) {";
  const ordered = "\n\tfor (const { id: pluginId } of orderedManifests) {";
  const end = "\n\tfactories.report();\n\treturn tools;\n}";
  const anchors = [start, missing, ordered, end];
  if (anchors.some((anchor) => source.split(anchor).length !== 2)) return undefined;
  const offsets = anchors.map((anchor) => source.indexOf(anchor));
  if (offsets.some((offset, index) => index > 0 && offset <= offsets[index - 1])) return undefined;
  // These locals and ownership lookup already exist in the native resolver.
  for (const expected of ["const { context, env, onlyPluginIds, allowlist, snapshot } = loadState;",
    "const toolOwners =", "const findRuntimeOwner =", "const missingPluginIds =",
    "const orderedManifests = loadState.loadOptions.manifestRegistry?.plugins ?? snapshot.plugins;"]) {
    if (!source.slice(offsets[0], offsets[3]).includes(expected)) return undefined;
  }
  const begin = `${start}\n\tlet ${MARKER} = 0;\n\ttry { ${MARKER} = globalThis[Symbol.for(${JSON.stringify(KEY)})]?.next() ?? 0; } catch {}`;
  const owner = `{
    selected: onlyPluginIds.includes("inkbox"),
    snapshot: snapshot.byPluginId.has("inkbox"),
    scoped: snapshot.pluginIds !== undefined,
    index: snapshot.index.plugins.some((entry) => entry.pluginId === "inkbox"),
    enabled: snapshot.index.plugins.find((entry) => entry.pluginId === "inkbox")?.enabled,
    ordered: loadState.loadOptions.manifestRegistry?.plugins?.some((entry) => entry.id === "inkbox"),
    owner: Boolean(findRuntimeOwner?.("inkbox")),
    complete: getPluginInstance(findRuntimeOwner?.("inkbox"))?.toolRegistrationComplete,
    cold: missingPluginIds.includes("inkbox"),
    registrations: runtimeRegistry?.tools?.filter((entry) => entry.pluginId === "inkbox").length
  }`;
  const loaded = `{
    selected: onlyPluginIds.includes("inkbox"),
    ordered: orderedManifests.some((entry) => entry.id === "inkbox"),
    owner: toolOwners.has("inkbox"),
    cold: missingPluginIds.includes("inkbox"),
    registrations: toolOwners.get("inkbox")?.tools.length,
    record: toolOwners.get("inkbox")?.registry?.plugins?.find((entry) => entry.id === "inkbox"),
    diagnostics: toolOwners.get("inkbox")?.registry?.diagnostics,
    loadedComplete: getPluginInstance(toolOwners.get("inkbox")?.registry?.plugins?.find((entry) => entry.id === "inkbox"))?.toolRegistrationComplete
  }`;
  const result = `{ returned: tools.filter((tool) => typeof tool.name === "string" && tool.name.startsWith("inkbox_")).length }`;
  return source.replace(end, observation("result", result) + end)
    .replace(ordered, observation("loaded", loaded) + ordered)
    .replace(missing, observation("owner", owner) + missing)
    .replace(start, begin);
}

export function installToolStateObserver(executable, write = (line) => process.stderr.write(`${line}\n`)) {
  let records = 0;
  let assemblies = 0;
  let reported = false;
  const safeWrite = (line) => {
    if (records++ >= MAX_RECORDS) return;
    try { write(line); } catch { /* Diagnostics must not alter native execution. */ }
  };
  try {
    const root = path.dirname(fs.realpathSync(executable));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (manifest.name !== "openclaw" || manifest.version !== "2026.9.6") throw new Error();
    const dist = fs.realpathSync(path.join(root, "dist"));
    if (dist !== path.join(root, "dist")) throw new Error();
    globalThis[Symbol.for(KEY)] = {
      next: () => ++assemblies,
      emit(phase, ordinal, values) {
        try {
          const line = projectToolState(phase, ordinal, values);
          if (line) safeWrite(line);
          if (phase === "loaded") safeWrite(projectLoadedPlugin(ordinal, values?.record, values?.diagnostics, values?.loadedComplete));
        } catch { /* Never replace a native result or error. */ }
      },
    };
    return registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      try {
        if (!url.startsWith("file:")) return loaded;
        const filename = fileURLToPath(url);
        if (path.dirname(filename) !== dist || path.basename(filename) !== "tools-CvXdkvXK.mjs" || fs.realpathSync(filename) !== filename) return loaded;
        const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
        const instrumented = instrumentToolState(source);
        if (!reported) {
          safeWrite(`native_tool_probe status=${instrumented ? "installed" : "unsupported"}`);
          reported = true;
        }
        return instrumented ? { ...loaded, source: instrumented } : loaded;
      } catch { return loaded; }
    } });
  } catch {
    safeWrite("native_tool_probe status=unavailable");
    return undefined;
  }
}

if (process.env.INKBOX_CI_NATIVE_HOST) installToolStateObserver(process.env.INKBOX_CI_NATIVE_HOST);
