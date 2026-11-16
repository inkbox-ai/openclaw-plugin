import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface HostedCheck { name: string; ok: boolean; detail: string }
export interface HostedReport { mode: "hosted"; context: string; ready: boolean; checks: HostedCheck[] }

export function hostedDiagnostics(identity: string | undefined, harness: string, signingKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env): HostedReport | null {
  if (env.INKBOX_HOSTED_MODE !== "1") return null;
  const context = env.INKBOX_DIAGNOSTIC_CONTEXT ?? "runtime";
  const checks: HostedCheck[] = [{ name: "delivery mode", ok: true,
    detail: "Managed delivery; ordinary webhook subscriptions are not required." }];
  checks.push(context === "terminal"
    ? { name: "terminal signing key", ok: true, detail: "Not exposed to the terminal; checked in the runtime report." }
    : { name: "runtime signing key", ok: Boolean(signingKey), detail: signingKey ? "Configured."
      : "Missing from this runtime; signed inbound delivery cannot be verified." });
  try {
    const fd = openSync(env.INKBOX_DIAGNOSTICS_FILE ?? "", constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const metadata = fstatSync(fd);
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error();
      const buffer = Buffer.alloc(4097);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > 4096) throw new Error();
      raw = buffer.subarray(0, length).toString("utf8");
    } finally { closeSync(fd); }
    const value = JSON.parse(raw);
    const age = Date.now() / 1000 - value.observed_at;
    if (value.version !== 1 || !identity || value.identity !== identity.replace(/^@/, "")
      || value.harness !== harness || typeof value.ready !== "boolean"
      || typeof value.signing_key_configured !== "boolean" || typeof value.observed_at !== "number"
      || !(age >= 0 && age <= 60) || !Number.isInteger(value.pid) || value.pid <= 0) throw new Error();
    process.kill(value.pid, 0);
    const ready = value.ready && value.signing_key_configured;
    checks.push({ name: "hosted runtime", ok: ready, detail: ready ? "Ready; signing key configured."
      : "Not ready; inspect runtime startup and delivery health." });
  } catch {
    checks.push({ name: "hosted runtime", ok: false,
      detail: "Status unavailable, stale, or mismatched; readiness is unverified." });
  }
  return { mode: "hosted", context, ready: checks.every((check) => check.ok), checks };
}
