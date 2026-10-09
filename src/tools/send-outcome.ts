import { setTimeout, clearTimeout } from "node:timers";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const failures = new Set(["declined", "error", "delivery_failed", "sending_failed", "blocked_spam_filter"]);
type Message = Record<string, any>;
export interface SendOutcome {
  status: string;
  service: string | null;
  delivery_final: boolean;
  error_code: unknown;
  error_detail: unknown;
  note: string;
}

export function sendOutcome(message: Message, kind: "sms" | "imessage", group = false): SendOutcome {
  const status = message.deliveryStatus ?? message.delivery_status ?? message.status ?? "unknown";
  let service = kind === "sms" ? message.type ?? "sms" : message.service ?? null;
  if (kind === "imessage" && ["registered", "pending", "unknown"].includes(status)) service = null;
  group = group || message.isGroup === true || message.is_group === true;
  const supplied = message.deliveryFinal ?? message.delivery_final;
  const final = typeof supplied === "boolean" ? supplied : failures.has(status) || status === "delivered" ||
    (kind === "sms" && status === "delivery_unconfirmed") ||
    (kind === "imessage" && status === "sent" && (group || service === "sms"));
  const detail = message.errorDetail ?? message.error_detail ?? message.errorMessage ?? message.error_message ?? null;
  let note = "Still in flight. Re-read the message for the outcome; do not resend.";
  const code = message.errorCode ?? message.error_code ?? null;
  if (code === "send_outcome_ambiguous" || (message.errorReason ?? message.error_reason) === "delivery_unconfirmed")
    note = "Delivery could not be confirmed. The outcome is unknown; do not resend.";
  else if (failures.has(status)) note = `Delivery failed: ${detail || "the message could not be delivered."}`;
  else if (status === "delivery_unconfirmed") note = "No delivery receipt was received; the outcome is unknown. Do not resend.";
  else if (status === "delivered") note = `Delivered${service ? ` via ${service}` : ""}.`;
  else if (status === "sent" && kind === "imessage" && (group || service === "sms"))
    note = `Sent${group ? " to the group" : " as a text message"}. No device delivery receipt is available.`;
  else if (status === "sent") note = "Sent; a delivery receipt has not yet been received. Do not resend.";
  return { status, service, delivery_final: final, error_code: code,
    error_detail: detail, note };
}

function setting(name: string, fallback: number, maximum: number, minimum = 0): number {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function markerPath(id: string): string {
  const root = join(process.env.INKBOX_SEND_OUTCOME_HOME ?? join(homedir(), ".openclaw", "inkbox"), "send_outcomes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, `${createHash("sha256").update(id).digest("hex")}.json`);
}

function mark(id: string, next: string): void {
  if (!id) return;
  try {
    const previous = state(id);
    if ((next !== "webhook" && previous === "webhook") || previous === "inline") return;
    const path = markerPath(id);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ state: next, at: Date.now() }), { mode: 0o600 });
    renameSync(temp, path);
    const root = join(path, "..");
    for (const entry of readdirSync(root)) {
      const old = join(root, entry);
      if (entry.endsWith(".json") && Date.now() - statSync(old).mtimeMs > 86400000) unlinkSync(old);
    }
  } catch { /* Observability failure is never permission to repeat an accepted send. */ }
}

function state(id: string): string | undefined {
  if (!id) return undefined;
  try {
    const data = JSON.parse(readFileSync(markerPath(id), "utf8"));
    if (Date.now() - data.at > (data.state === "polling" ? 11000 : 86400000)) return undefined;
    return data.state;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function reportedInline(id: string): Promise<boolean> {
  const deadline = performance.now() + 10000;
  while (state(id) === "polling" && performance.now() < deadline) await sleep(50);
  if (state(id) === "inline") return true;
  mark(id, "webhook");
  return false;
}

async function readBeforeDeadline(get: () => Promise<Message>, ms: number): Promise<Message | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([get(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally { clearTimeout(timer); }
}

export async function pollSendOutcome(runtime: { getClient(): Promise<any> }, identity: any,
  kind: "sms" | "imessage", message: Message, group = false): Promise<SendOutcome> {
  const id = String(message.id ?? "");
  group = group || message.isGroup === true || message.is_group === true;
  let result = sendOutcome(message, kind, group);
  const deadline = performance.now() + setting("INKBOX_SEND_POLL_SECONDS", 5, 10) * 1000;
  const interval = setting("INKBOX_SEND_POLL_INTERVAL_SECONDS", 0.5, 10, 0.05) * 1000;
  mark(id, "polling");
  try {
    if (!id || result.delivery_final) return result;
    const client = kind === "imessage" ? await readBeforeDeadline(() => runtime.getClient(), Math.max(0, deadline - performance.now())) : undefined;
    const get = kind === "sms" ? (typeof identity.getText === "function" ? () => identity.getText(id) : undefined)
      : (typeof client?.imessages?.get === "function" ? () => client.imessages.get(id, identity.id ? { agentIdentityId: identity.id } : undefined) : undefined);
    if (!get) return result;
    for (let count = 0; count < 20 && !result.delivery_final; count++) {
      if (deadline - performance.now() <= interval) break;
      await sleep(interval);
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const latest = await readBeforeDeadline(get, remaining);
      if (!latest || (latest.id != null && String(latest.id) !== id) || latest.direction === "inbound") break;
      result = sendOutcome(latest, kind, group);
    }
  } catch { /* Keep the latest accepted state when an observation fails. */ }
  finally {
    mark(id, failures.has(result.status) ? "inline" : "done");
    if (failures.has(result.status) && state(id) === "webhook")
      result.note += " A delivery-failure update was already reported; do not start another retry from this result.";
  }
  return result;
}

export function outcomeText(outcome: SendOutcome): string {
  return `status=${outcome.status} service=${outcome.service ?? "unknown"} delivery_final=${outcome.delivery_final} error_code=${outcome.error_code ?? "none"} error_detail=${outcome.error_detail ?? "none"}. ${outcome.note}`;
}
