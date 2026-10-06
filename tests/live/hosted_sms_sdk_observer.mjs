// CI-only preload. Observe the exact published SDK class loaded by native graphs.
import { readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const registryKey = Symbol.for("inkbox.ci.hosted-sms-observer.v1");
const statuses = new Set(["installed", "unavailable", "observed", "accepted", "rejected", "threw"]);
const booleans = ["module_bound", "marker_matches", "target_known", "target_matches", "accepted_id_present", "same_id_as_prior", "id_tracking_available", "original_promise", "truncated"];
export function safeRecord(value) {
  if (!value || typeof value !== "object" || !["observer", "sdk"].includes(value.phase) || !statuses.has(value.status)) return null;
  const out = { phase: value.phase, status: value.status };
  if (["request", "response", "unavailable"].includes(value.target_basis)) out.target_basis = value.target_basis;
  for (const key of booleans) if (typeof value[key] === "boolean") out[key] = value[key];
  for (const key of ["ordinal", "unique_accepted"]) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 128) out[key] = value[key];
  return out;
}
function markerKey(value) { return value.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase(); }
function digits(value) { return typeof value === "string" ? value.replace(/\D/g, "") : ""; }

export function createObserver({ marker, readTarget, emit }) {
  const ids = new Set();
  const attached = new WeakSet();
  let ordinal = 0;
  const output = (value) => { try { const row = safeRecord(value); if (row) emit(row); } catch {} };
  function attach(Identity) {
    try {
      if (attached.has(Identity)) return;
      const original = Identity?.prototype?.sendText;
      if (typeof original !== "function") throw Error("unsupported SDK");
      const descriptor = Object.getOwnPropertyDescriptor(Identity.prototype, "sendText");
      if (!descriptor?.writable) throw Error("unsupported SDK");
      Object.defineProperty(Identity.prototype, "sendText", { ...descriptor, value: function (...args) {
        let shape, expected;
        try {
          const payload = args[0];
          expected = digits(readTarget());
          const destinations = Array.isArray(payload?.to) ? payload.to : typeof payload?.to === "string" ? [payload.to] : [];
          shape = {
            ordinal: Math.min(++ordinal, 128), truncated: ordinal > 128,
            marker_matches: typeof marker === "string" && marker.length > 0 && typeof payload?.text === "string" && markerKey(payload.text.slice(0, 20_000)).includes(markerKey(marker)),
            target_basis: expected.length > 0 && destinations.length > 0 ? "request" : "unavailable",
            target_known: expected.length > 0 && destinations.length > 0,
            target_matches: expected.length > 0 && destinations.length === 1 && digits(destinations[0]) === expected,
          };
        } catch { output({ phase: "observer", status: "unavailable" }); }
        let returned;
        try { returned = Reflect.apply(original, this, args); }
        catch (error) { output({ phase: "sdk", status: "threw", ...shape }); throw error; }
        try {
          if (!returned || typeof returned.then !== "function") throw Error("unsupported SDK result");
          output({ phase: "sdk", status: "observed", ...shape, original_promise: true });
          // Do not wrap/replace the original Promise, value, or rejection.
          returned.then((result) => {
            try {
              const id = typeof result?.id === "string" && result.id.length <= 256 ? result.id : undefined;
              const recipients = Array.isArray(result?.recipients) ? result.recipients.map(row => digits(row?.recipientPhoneNumber)).filter(Boolean) : [];
              if (recipients.length === 0 && typeof result?.remotePhoneNumber === "string") recipients.push(digits(result.remotePhoneNumber));
              const acceptedShape = recipients.length > 0 && expected ? { ...shape, target_basis: "response", target_known: true,
                target_matches: recipients.length === 1 && recipients[0] === expected } : shape;
              const matches = acceptedShape?.marker_matches && acceptedShape?.target_matches;
              const same = Boolean(matches && id && ids.has(id));
              const tracking = !matches || !id || same || ids.size < 128;
              if (matches && id && tracking) ids.add(id);
              output({ phase: "sdk", status: "accepted", ...acceptedShape,
                accepted_id_present: Boolean(id), same_id_as_prior: same,
                id_tracking_available: tracking, unique_accepted: ids.size });
            } catch { output({ phase: "observer", status: "unavailable" }); }
          }, () => { output({ phase: "sdk", status: "rejected", ...shape }); }).catch(() => {});
        } catch { output({ phase: "observer", status: "unavailable" }); }
        return returned;
      } });
      attached.add(Identity);
      output({ phase: "observer", status: "installed", module_bound: true });
    } catch { output({ phase: "observer", status: "unavailable", module_bound: false }); }
  }
  return { attach };
}

export function startPreload({ marker, statePath, outputPath, hooks = registerHooks }) {
  const records = [];
  const packages = new Map();
  function emit(value) {
    try {
      const record = safeRecord(value);
      if (!record) return;
      if (records.length >= 128) { records.splice(8, 1); record.truncated = true; }
      records.push(record);
      writeFileSync(outputPath, JSON.stringify(records), { mode: 0o600 });
    } catch { /* Diagnostics cannot affect the gateway. */ }
  }
  const observer = createObserver({ marker, emit, readTarget: () => {
    const fd = openSync(statePath, "r");
    try {
      const buffer = Buffer.alloc(16_385);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > 16_384) return undefined;
      return JSON.parse(buffer.toString("utf8", 0, length))?.number;
    } finally { closeSync(fd); }
  } });
  // The attachment itself emits module_bound=true only when an actual class loads.
  emit({ phase: "observer", status: "unavailable", module_bound: false });
  globalThis[registryKey] = observer;
  try {
    return hooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      try {
        if (!url.startsWith("file:") || !new URL(url).pathname.endsWith("/agent_identity.js")) return loaded;
        const file = fileURLToPath(url);
        const packagePath = resolve(dirname(file), "..", "package.json");
        if (!packages.has(packagePath)) {
          if (packages.size >= 16) { emit({ phase: "observer", status: "unavailable" }); return loaded; }
          const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
          packages.set(packagePath, metadata.name === "@inkbox/sdk" && metadata.version === "0.7.14");
        }
        if (packages.get(packagePath) !== true || loaded.format !== "module") {
          emit({ phase: "observer", status: "unavailable", module_bound: false }); return loaded;
        }
        const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
        if (!source.includes("export class AgentIdentity")) { emit({ phase: "observer", status: "unavailable" }); return loaded; }
        return { ...loaded, source: `${source}\ntry { globalThis[Symbol.for("inkbox.ci.hosted-sms-observer.v1")]?.attach(AgentIdentity); } catch {}\n` };
      } catch { emit({ phase: "observer", status: "unavailable" }); return loaded; }
    } });
  } catch { emit({ phase: "observer", status: "unavailable", module_bound: false }); return undefined; }
}

if (process.env.HOSTED_SMS_SDK_DIAGNOSTICS && process.env.HOSTED_POST_CALL_MARKER && process.env.DRIVER_STATE && !globalThis[registryKey]) {
  startPreload({ marker: process.env.HOSTED_POST_CALL_MARKER, statePath: process.env.DRIVER_STATE, outputPath: `${process.env.HOSTED_SMS_SDK_DIAGNOSTICS}.${process.pid}` });
}
