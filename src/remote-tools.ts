import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { RemoteMcp, type RemoteTool } from "@inkbox/sdk/remote-mcp";
import type { InkboxRuntime, InkboxPluginConfig } from "./client.js";
import { activeNativeSource, assertNativeSource, type NativeSource } from "./native-source.js";
import { guardRetiredNativeRun } from "./native-owner.js";
import { checkOutboundRecipients } from "./allowlist.js";
import { terminalReply } from "./terminal-reply.js";
import { statePaths } from "./state.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const aliases: Record<string, string> = {
  inkbox_lookup_contact: "inkbox_contacts_list", inkbox_list_contacts: "inkbox_contacts_list",
  inkbox_get_contact: "inkbox_contact_get", inkbox_create_contact: "inkbox_contact_create",
  inkbox_update_contact: "inkbox_contact_update", inkbox_delete_contact: "inkbox_contact_delete",
};
type Context = { sessionKey?: string; sessionId?: string; runId?: string; toolCallId?: string };
type Catalog = { remote?: RemoteMcp; tools: RemoteTool[]; legacy?: boolean; identity: string };
type Turn = { key: string; runId?: string; retired: boolean; source?: NativeSource; catalog?: Promise<Catalog>; approvals: Map<string, string> };
export type ManagedToolPolicy = { mode: "ask" | "yolo"; runId?: string; validate(): Promise<void>; ask?(request: { name: string; arguments: Record<string, unknown>; callId: string }): Promise<boolean> };
const policyKey = Symbol.for("inkbox.managed-tool-policy.v1");
const sharedPolicies = globalThis as typeof globalThis & { [policyKey]?: Map<string, ManagedToolPolicy> };
const policies = sharedPolicies[policyKey] ??= new Map<string, ManagedToolPolicy>();
export function bindManagedToolPolicy(sessionKey: string, policy: ManagedToolPolicy): () => void {
  if (policies.has(sessionKey)) throw new Error("The managed session already has a tool policy.");
  policies.set(sessionKey, policy);
  return () => { if (policies.get(sessionKey) === policy) policies.delete(sessionKey); };
}

function contactArguments(name: string, args: Record<string, any>, operation: string): Record<string, unknown> {
  const result: Record<string, any> = Object.fromEntries(Object.entries(args).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  if (name === "inkbox_lookup_contact" && Object.values(result).filter(Boolean).length !== 1) throw new Error("Contact lookup requires exactly one criterion.");
  if (name === "inkbox_list_contacts") return { limit: 25, ...result };
  if (name === "inkbox_delete_contact") return { ...result, idempotency_key: operation };
  if (!["inkbox_create_contact", "inkbox_update_contact"].includes(name)) return result;
  const contactId = result.contact_id; delete result.contact_id;
  for (const [field, valueKey] of [["emails", "value"], ["phones", "value_e164"]]) {
    if (Array.isArray(result[field])) result[field] = result[field].map((entry: any) => ({ [valueKey]: entry.value, label: entry.label ?? null, is_primary: Boolean(entry.isPrimary) }));
  }
  return { ...(name === "inkbox_create_contact" ? { contact: result } : { contact_id: contactId, patch: result }), idempotency_key: operation };
}

export class RemoteTools {
  private readonly turns = new Map<string, Turn>();
  constructor(private readonly runtime: InkboxRuntime, private readonly config: () => Partial<InkboxPluginConfig>, private readonly home = statePaths().dir) {}
  private turn(context: Context): Turn {
    if (!context.sessionKey || !context.sessionId) throw new Error("Remote tools require a native session identity.");
    const key = hash([context.sessionKey, context.sessionId]);
    let turn = this.turns.get(key);
    if (!turn || context.runId && turn.runId && context.runId !== turn.runId) {
      if (turn) turn.retired = true;
      if (this.turns.size >= 4096) throw new Error("Remote session capacity reached; reconnect inactive sessions.");
      turn = { key, runId: context.runId, retired: false, source: activeNativeSource(context.sessionKey), approvals: new Map() };
      this.turns.set(key, turn);
    }
    if (context.runId && !turn.runId) turn.runId = context.runId;
    return turn;
  }
  begin(context: Context): void {
    if (!context.sessionKey || !context.sessionId) return;
    const key = hash([context.sessionKey, context.sessionId]); const previous = this.turns.get(key);
    if (previous?.runId === context.runId) return;
    if (previous) { previous.retired = true; this.turns.delete(key); }
    this.turn(context);
  }
  end(context: Context): void {
    if (!context.sessionKey || !context.sessionId) return;
    const key = hash([context.sessionKey, context.sessionId]); const turn = this.turns.get(key);
    if (turn && turn.runId === context.runId) { turn.retired = true; this.turns.delete(key); }
  }
  private async validate(turn: Turn, context: Context): Promise<void> {
    if (turn.retired || turn.runId && context.runId && turn.runId !== context.runId || guardRetiredNativeRun({}, context)) throw new Error("The native turn is no longer active.");
    const source = turn.source;
    if (source) {
      if (source !== activeNativeSource(context.sessionKey) || source.closed || source.nativeSessionId && source.nativeSessionId !== context.sessionId || source.runId && source.runId !== turn.runId) throw new Error("The incoming source is no longer active.");
      await source.validate();
    }
    const policy = context.sessionKey ? policies.get(context.sessionKey) : undefined;
    if (policy) {
      if (policy.runId && policy.runId !== turn.runId) throw new Error("The managed tool policy belongs to another turn.");
      await policy.validate();
    }
  }
  private async catalog(turn: Turn, context: Context, signal?: AbortSignal): Promise<Catalog> {
    await this.validate(turn, context);
    turn.catalog ??= (async () => {
      const client = await this.runtime.getClient(); const authority = await client.whoami();
      if (["api_key.admin_scoped", "api_key.agent_scoped.unclaimed"].includes(authority.authSubtype ?? "")) return { tools: [], legacy: true, identity: "" };
      if (authority.authSubtype !== "api_key.agent_scoped.claimed") throw new Error("Remote tools require current claimed identity authority.");
      const identity = await this.runtime.getIdentity();
      if (turn.source) assertNativeSource(turn.source, identity.id);
      const remote = new RemoteMcp({ apiKey: client._apiKey, baseUrl: client._baseUrl, identity: identity.id, journalPath: join(this.home, "remote-calls", hash(context.sessionKey)) });
      return { identity: identity.id, remote, tools: await remote.refresh({ signal }) };
    })();
    const catalog = await turn.catalog; await this.validate(turn, context); return catalog;
  }
  async before(event: { toolName: string; toolCallId?: string; params: Record<string, any> }, context: Context): Promise<any> {
    const managed = context.sessionKey ? policies.get(context.sessionKey) : undefined;
    const remoteCall = event.toolName === "inkbox_remote_call" || event.toolName === "inkbox_reply_current" || Boolean(aliases[event.toolName]);
    if (!remoteCall && !managed) return;
    if (event.toolName === "inkbox_remote_tools") return;
    try {
      const turn = this.turn(context); await this.validate(turn, context);
      if (remoteCall) {
        const catalog = await this.catalog(turn, context);
        if (catalog.legacy && !managed) return;
        const name = event.toolName === "inkbox_reply_current" ? turn.source?.replyChannel === "email" ? "inkbox_email_reply" : turn.source?.replyChannel === "sms" ? "inkbox_text_send" : undefined : aliases[event.toolName] ?? event.params.name;
        if (!catalog.legacy && !catalog.tools.some(tool => tool.name === name)) throw new Error("The tool is unavailable in this catalog generation.");
      }
      const id = event.toolCallId ?? context.toolCallId;
      if (!id) throw new Error("Native tool-call identity is unavailable.");
      const fingerprint = hash([event.toolName, event.params]);
      if (turn.source && !managed || managed?.mode === "yolo") { turn.approvals.set(id, fingerprint); return; }
      if (managed?.ask) {
        if (!await managed.ask({ name: event.toolName, arguments: structuredClone(event.params), callId: id })) throw new Error("Tool execution was denied.");
        await this.validate(turn, context);
        if (fingerprint !== hash([event.toolName, event.params])) throw new Error("Tool arguments changed during approval.");
        turn.approvals.set(id, fingerprint); return;
      }
      return { requireApproval: { title: "Approve tool execution", description: `Run ${event.toolName}?`, severity: "warning", pluginId: "inkbox", timeoutBehavior: "deny", allowedDecisions: ["allow-once", "deny"], onResolution: (decision: string) => {
        if (decision === "allow-once" && !turn.retired) turn.approvals.set(id, fingerprint);
      } } };
    } catch (error) { return { block: true, blockReason: error instanceof Error ? error.message : "Tool authority is unavailable." }; }
  }
  private async call(local: string, name: string, args: Record<string, unknown>, original: Record<string, unknown>, id: string, context: Context, signal?: AbortSignal, options?: { operation: string; journal: string; submit(): Promise<void> }) {
    const turn = this.turn(context); const catalog = await this.catalog(turn, context, signal);
    if (!catalog.remote) throw new Error("Remote tools are unavailable until this identity is claimed.");
    const check = async () => {
      await this.validate(turn, context);
      if (turn.approvals.get(id) !== hash([local, original])) throw new Error("This native tool call has not been approved.");
      const allowed = this.config().allowedRecipients;
      if (allowed?.length) {
        const recipients = name === "inkbox_email_reply" && args.approved_recipients && typeof args.approved_recipients === "object" ? Object.values(args.approved_recipients).flat() : name === "inkbox_email_send" || name === "inkbox_email_forward" ? args.recipients && typeof args.recipients === "object" ? Object.values(args.recipients).flat() : [] : name === "inkbox_text_send" ? args.to : name === "inkbox_imessage_send" ? [args.recipient].flat() : null;
        if (Array.isArray(recipients) && recipients.length && recipients.every(value => typeof value === "string")) {
          const blocked = checkOutboundRecipients(recipients as string[], allowed); if (blocked) throw new Error(blocked);
        } else if (!Object.values(aliases).includes(name)) throw new Error("This remote tool cannot enforce the configured recipient allowlist.");
      }
    };
    return catalog.remote.call(name, args, { callIdentity: options?.operation ?? `${context.sessionId}:${id}`, ...(options ? { journalPath: options.journal, beforeSubmit: async () => { await check(); await options.submit(); } } : {}), signal, beforeExecute: check });
  }
  wrap(api: any): any {
    return { ...api, registerTool: (definition: any, options?: any) => {
      if (typeof definition !== "function" && aliases[definition.name]) {
        api.registerTool((context: Context) => ({ ...definition, execute: async (id: string, args: any, signal?: AbortSignal) => {
          const turn = this.turn(context); const catalog = await this.catalog(turn, context, signal);
          if (catalog.legacy) return definition.execute(id, args, signal);
          const operation = hash([context.sessionId, id]);
          return this.call(definition.name, aliases[definition.name]!, contactArguments(definition.name, args, operation), args, id, context, signal);
        } }), { ...options, names: [definition.name] });
      } else api.registerTool(definition, options);
    } };
  }
  register(api: any): void {
    api.registerTool((context: Context) => [
      { name: "inkbox_remote_tools", label: "Inkbox tools", description: "Read the current Inkbox tool catalog, including complete JSON schemas. Refreshes between native turns. Use the exact schema with inkbox_remote_call.", parameters: Type.Object({ name: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), execute: async (_id: string, args: { name?: string; offset?: number }, signal?: AbortSignal) => {
        const catalog = await this.catalog(this.turn(context), context, signal);
        if (!catalog.remote) throw new Error("Claim this identity before using remote tools; existing local tools remain available.");
        const tools = args.name ? catalog.tools.filter(tool => tool.name === args.name) : catalog.tools.slice(args.offset ?? 0, (args.offset ?? 0) + 20);
        return { content: [{ type: "text", text: JSON.stringify({ digest: catalog.remote.catalogDigest, tools, next_offset: !args.name && (args.offset ?? 0) + 20 < catalog.tools.length ? (args.offset ?? 0) + 20 : null }) }] };
      } },
      { name: "inkbox_remote_call", label: "Call Inkbox tool", description: "Execute a tool from inkbox_remote_tools with its exact JSON arguments. General sends are progress, not the automatic final reply. Native approvals and current identity permissions still apply.", parameters: Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }), execute: (id: string, args: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal) => this.call("inkbox_remote_call", args.name, args.arguments, args, id, context, signal) },
      { name: "inkbox_reply_current", label: "Reply to current message", description: "Send the final reply to the admitted incoming email or direct SMS. Destination is fixed by the source. A confirmed receipt suppresses the automatic final reply; general sends do not.", parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 12000 }) }), execute: async (id: string, args: { text: string }, signal?: AbortSignal) => {
        const turn = this.turn(context); const catalog = await this.catalog(turn, context, signal);
        if (!catalog.remote || !turn.source) throw new Error("No admitted reply source is active.");
        return terminalReply(catalog.remote, this.runtime, turn.source, args.text, () => this.validate(turn, context), (name, values, operation, journal, submit) => this.call("inkbox_reply_current", name, values, args, id, context, signal, { operation, journal, submit }), this.home);
      } },
    ], { names: ["inkbox_remote_tools", "inkbox_remote_call", "inkbox_reply_current"] });
  }
}
