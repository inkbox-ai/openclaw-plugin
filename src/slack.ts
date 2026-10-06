import { createHash } from "node:crypto";
import type { Inkbox, SlackConnection } from "@inkbox/sdk";

export const SLACK_EVENTS = ["slack.dm_received", "slack.group_dm_received", "slack.channel_message_received", "slack.mention_received", "slack.thread_reply_received"] as const;
export const SLACK_STOP = "slack.session_stopped";
export const SLACK_SUBSCRIPTION_EVENTS = [...SLACK_EVENTS, SLACK_STOP];
export type SlackRoute = {
  identityId: string; connectionId: string; workspaceId: string; conversationId: string;
  actorId: string; messageTs: string; threadTs: string | null; sourceEventId: string;
  author: string; mentioned: boolean; addressed: boolean; direct: boolean;
  rawText: string; text: string; senderAccess?: string; contactId?: string; nativeStop?: boolean;
};
const record = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim()) && !v.includes("\0");
export function parseSlack(event: Record<string, any>, identityId: string): SlackRoute | undefined {
  const d = event.data;
  if (!record(d) || d.identity_id !== identityId || !nonempty(event.id)) return;
  if (![...SLACK_EVENTS, SLACK_STOP].includes(event.event_type)) return;
  const stop = event.event_type === SLACK_STOP;
  if (!record(d.event) || (stop && d.event.type !== "agent_session_stopped")) return;
  if (!stop && "sender_access" in d && (!['direct', 'sponsored'].includes(d.sender_access) || (d.sender_access === "sponsored" && !event.companion))) return;
  if (!["connection_id", "workspace_id", "conversation_id", "actor_id"].every((k) => nonempty(d[k]))) return;
  if (d.event.bot_id || d.event.app_id || d.event.subtype === "bot_message") return;
  if (d.thread_ts != null && !nonempty(d.thread_ts)) return;
  if (stop && !d.thread_ts) return;
  const messageTs = stop ? d.thread_ts : d.message_ts;
  if (!nonempty(messageTs)) return;
  const kinds = stop ? ["thread"] : d.message_kinds ?? [];
  if (!Array.isArray(kinds)) return;
  const direct = kinds.includes("dm"), mentioned = kinds.includes("mention");
  const rawText = stop ? "/stop" : d.event.text ?? "";
  if (typeof rawText !== "string") return;
  const files = Array.isArray(d.event.files) ? d.event.files.filter(record).map((f: Record<string, unknown>) => Object.fromEntries(["id", "name", "mimetype", "size"].filter((k) => k in f).map((k) => [k, f[k]]))) : [];
  const text = rawText + (files.length ? `\nAttachment references (not downloaded): ${JSON.stringify(files)}` : "");
  if (!text.trim()) return;
  return {
    identityId, connectionId: d.connection_id, workspaceId: d.workspace_id, conversationId: d.conversation_id,
    actorId: d.actor_id, messageTs, threadTs: d.thread_ts || (direct && !mentioned ? null : messageTs),
    sourceEventId: event.id, author: `${d.workspace_id}:${d.actor_id}`, mentioned, direct,
    addressed: direct || mentioned || kinds.includes("group_dm"), rawText, text,
    senderAccess: d.sender_access, contactId: typeof d.contact_id === "string" ? d.contact_id : undefined, nativeStop: stop,
  };
}
export function slackRouteKey(route: SlackRoute): string {
  return JSON.stringify([route.identityId, route.connectionId, route.conversationId, route.threadTs]);
}
export function slackControlText(route: SlackRoute, botUserId?: string): string {
  return botUserId ? route.rawText.replace(new RegExp(`^\\s*<@${botUserId}>[,:]?\\s*`), "").trim() : route.rawText.trim();
}
export async function ownSlackConnection(client: Inkbox, identityId: string, connectionId: string): Promise<SlackConnection> {
  const matches = (await client.slack.listConnections(identityId)).connections.filter((c) => c.id === connectionId);
  if (matches.length !== 1 || matches[0]!.identityId !== identityId || matches[0]!.status !== "connected") throw new Error("Slack connection is not connected to this identity.");
  return matches[0]!;
}
export async function reconcileSlackSubscription(client: Inkbox, identityId: string, url: string): Promise<void> {
  const subscriptions = client.webhooks.subscriptions;
  const rows = (await subscriptions.list({ agentIdentityId: identityId, scope: "identity", url })).filter((s) => s.url === url && s.eventTypes.some((e) => SLACK_SUBSCRIPTION_EVENTS.includes(e)));
  if (rows.some((s) => s.status !== "active")) throw new Error("The Slack subscription is paused; resume it before starting.");
  const covered = new Set(rows.flatMap((s) => s.eventTypes));
  const missing = SLACK_SUBSCRIPTION_EVENTS.filter((e) => !covered.has(e));
  if (!missing.length) return;
  const messages = rows.filter((s) => s.eventTypes.some((e) => (SLACK_EVENTS as readonly string[]).includes(e))).sort((a, b) => b.eventTypes.length - a.eventTypes.length);
  if (messages.length) await subscriptions.update(messages[0]!.id, { scope: "identity", eventTypes: [...new Set([...messages[0]!.eventTypes, ...missing])] });
  else await subscriptions.create({ agentIdentityId: identityId, url, eventTypes: missing });
}
export function slackText(text: string): void {
  if (!text || [...text].length > 12_000 || text.includes("\0")) throw new Error("Slack text must be 1–12000 characters without NUL characters.");
}
export function slackAuthorAllowed(allowed: readonly string[] | undefined, author: string, route?: SlackRoute): boolean {
  const aliases = [author, ...(route && /^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(author) ? [`${route.workspaceId}:${author.split(":")[1]}`] : [])];
  return !allowed?.length || allowed.some((value) => aliases.some((alias) => value.trim().toLowerCase() === alias.toLowerCase()));
}
export async function sendSlackReply(client: Inkbox, route: SlackRoute, text: string, beforeSend?: () => Promise<void>): Promise<string> {
  slackText(text);
  const connection = await ownSlackConnection(client, route.identityId, route.connectionId);
  if (connection.workspaceId !== route.workspaceId) throw new Error("Slack reply workspace changed.");
  const key = createHash("sha256").update(JSON.stringify([route.sourceEventId, slackRouteKey(route), text])).digest("hex");
  await beforeSend?.();
  const action = await client.slack.sendMessage(route.connectionId, { conversationId: route.conversationId, threadTs: route.threadTs, text, idempotencyKey: `openclaw:${key}` });
  if (action.status !== "sent") throw new Error(`Slack action ${action.id} is ${action.status}; inspect it with inkbox_slack_get_action before deciding whether to send again.`);
  return action.id;
}
function timestampTicks(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(value)) throw new Error("Invalid Slack message timestamp.");
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
}
function ticksTimestamp(value: bigint): string { return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`; }
export type SlackSource = { id: string; author: string; threadTs: string | null; botUserId: string; route: SlackRoute };
export async function prepareSlackSource(client: Inkbox, identityId: string, event: Record<string, any>): Promise<SlackSource> {
  const route = parseSlack(event, identityId);
  if (!route || route.nativeStop || !event.companion) throw new Error("Invalid Slack Companion source.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![identityId, route.connectionId].every((v) => uuid.test(v)) || !/^T[A-Z0-9]{1,63}$/.test(route.workspaceId) || !/^[CGD][A-Z0-9]{1,63}$/.test(route.conversationId) || !/^[UW][A-Z0-9]{1,63}$/.test(route.actorId)) throw new Error("Invalid Slack Companion coordinates.");
  const connection = await ownSlackConnection(client, identityId, route.connectionId);
  if (connection.workspaceId !== route.workspaceId) throw new Error("Slack workspace does not match its connection.");
  const ticks = timestampTicks(route.messageTs);
  if (ticks <= 0n || ticks + 1n >= 1_000_000_000_000_000_000n) throw new Error("Slack timestamp is outside the supported range.");
  const page = await client.slack.listArchivedMessages(route.connectionId, { conversationId: route.conversationId, afterTs: ticksTimestamp(ticks - 1n), beforeTs: ticksTimestamp(ticks + 1n), limit: 2 });
  const source = page.messages[0];
  const thread = (message: string, value: string | null | undefined) => value == null || timestampTicks(value) === timestampTicks(message) ? null : value;
  route.threadTs = thread(route.messageTs, event.data.thread_ts);
  if (page.messages.length !== 1 || page.nextCursor || !source || !uuid.test(source.id) || source.connectionId !== route.connectionId || source.conversationId !== route.conversationId || timestampTicks(source.messageTs) !== ticks || source.userId !== route.actorId || source.source !== "event" || thread(source.messageTs, source.threadTs) !== route.threadTs) throw new Error("Slack archived source does not match the current message.");
  let profile = event.data.actor_profile;
  if (profile?.id !== route.actorId || !/^T[A-Z0-9]{1,63}$/.test(profile?.team_id ?? "")) profile = await client.slack.getUser(route.connectionId, route.actorId);
  if (profile?.id !== route.actorId || !/^T[A-Z0-9]{1,63}$/.test(profile?.team_id ?? "")) throw new Error("Slack sender home workspace is unavailable.");
  route.author = `${profile.team_id}:${route.actorId}`;
  return { id: source.id, author: route.author, threadTs: route.threadTs, botUserId: connection.botUserId, route };
}
