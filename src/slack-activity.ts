import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SlackResource } from "@inkbox/sdk";
import type { SlackRoute } from "./slack.js";

type State = "processing" | "suspended" | "active" | "completed" | "failed";
type ActivityRecord = { route: SlackRoute; state: State; token: string };
export type SlackActivityEvent = "accepted" | "waiting" | "resumed" | "completed" | "failed" | "cancelled";
export function createSlackActivity(resource: (route?: SlackRoute) => Promise<SlackResource>, path: string, warn: (message: string) => void = () => {}) {
  const active = new Map<string, Map<string, "processing" | "suspended">>();
  const records: Record<string, ActivityRecord> = {};
  const tails = new Map<string, Promise<void>>();
  let writes = Promise.resolve(), closing = false;
  function key(route: SlackRoute) { return createHash("sha256").update(JSON.stringify([route.connectionId, route.conversationId, route.threadTs ? "native" : "inline", route.threadTs ?? route.messageTs])).digest("hex"); }
  function persist(): Promise<void> {
    const snapshot = JSON.stringify(records);
    writes = writes.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    }).catch(() => warn("Slack activity cleanup could not be saved."));
    return writes;
  }
  function schedule(id: string, value: ActivityRecord) {
    records[id] = value;
    const saved = persist(), previous = tails.get(id);
    const task = (async () => {
      await previous; await saved;
      let success = true;
      for (let attempt = 0; attempt < 3; attempt++) {
      success = true;
      try {
        const slack = await resource(value.route), r = value.route;
        const operation = (method: string) => ({ idempotencyKey: `openclaw:activity:${createHash("sha256").update(`${id}:${value.token}:${value.state}:${method}`).digest("hex")}` });
        const check = (result: { status: string }) => { if (result.status !== "succeeded") { success = false; warn("Slack activity was not confirmed; the reply is unaffected."); } };
        if (r.threadTs) {
          check(await slack.setProcessingStatus(r.connectionId, r.conversationId, r.threadTs, value.state as "processing" | "suspended" | "active", operation("status")));
        } else if (value.state === "processing") {
          check(await slack.addReaction(r.connectionId, r.conversationId, r.messageTs, "eyes", operation("add-eyes")));
          check(await slack.removeReaction(r.connectionId, r.conversationId, r.messageTs, "x", operation("remove-x")));
        } else {
          check(await slack.removeReaction(r.connectionId, r.conversationId, r.messageTs, "eyes", operation("remove-eyes")));
          if (value.state === "failed") check(await slack.addReaction(r.connectionId, r.conversationId, r.messageTs, "x", operation("add-x")));
        }
      } catch { success = false; warn("Slack activity is unavailable; the reply is unaffected."); }
      if (success || attempt === 2 || records[id] !== value) break;
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, (attempt + 1) * 250); timer.unref?.(); });
      }
      if (success && ["active", "completed", "failed"].includes(value.state) && records[id] === value) { delete records[id]; await persist(); }
    })();
    tails.set(id, task);
    void task.finally(() => { if (tails.get(id) === task) tails.delete(id); });
  }
  return {
    async recover() {
      try {
        const old = JSON.parse(await readFile(path, "utf8"));
        if (!old || typeof old !== "object" || Array.isArray(old)) return;
        for (const [id, item] of Object.entries(old)) {
          if (active.has(id)) continue;
          const value = item as ActivityRecord;
          if (!value?.route?.connectionId || !value.route.conversationId || !value.route.messageTs || !["processing", "suspended", "active", "completed", "failed"].includes(value.state)) continue;
          const state: State = value.route.threadTs ? "active" : value.state === "failed" ? "failed" : "completed";
          schedule(id, { ...value, state, token: randomUUID() });
        }
      } catch (error: any) { if (error?.code !== "ENOENT") warn("Slack activity cleanup state could not be read."); }
    },
    notify(route: SlackRoute, event: SlackActivityEvent) {
      if (closing) return;
      const id = key(route), members = active.get(id) ?? new Map<string, "processing" | "suspended">();
      if (event === "accepted") { if (members.has(route.sourceEventId)) return; members.set(route.sourceEventId, "processing"); }
      else if (event === "waiting" || event === "resumed") { if (!members.has(route.sourceEventId)) return; members.set(route.sourceEventId, event === "waiting" ? "suspended" : "processing"); }
      else { if (!members.delete(route.sourceEventId)) return; }
      if (members.size) active.set(id, members); else active.delete(id);
      const state: State = members.size ? (route.threadTs && [...members.values()].includes("suspended") ? "suspended" : "processing") : route.threadTs ? "active" : event === "failed" ? "failed" : "completed";
      if (records[id]?.state !== state) schedule(id, { route, state, token: randomUUID() });
    },
    async flush() { while (tails.size) { await Promise.allSettled([...tails.values()]); await Promise.resolve(); } await writes; },
    async close() {
      closing = true;
      for (const id of active.keys()) if (records[id]) schedule(id, { ...records[id]!, state: records[id]!.route.threadTs ? "active" : "completed", token: randomUUID() });
      active.clear();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.flush(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    },
  };
}
