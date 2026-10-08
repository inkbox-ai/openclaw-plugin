import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

/** Immutable origin; no model text, arguments, paths, or tool output belongs here. */
export interface ProgressRoute {
  connectionGeneration?: number;
  recipientTeamId?: string;
  identityId: string;
  connectionId: string;
  workspaceId: string;
  conversationId: string;
  actorId: string;
  author: string;
  messageTs: string;
  threadTs: string | null;
  sourceEventId: string;
}
export type ProgressEvent =
  | "accepted"
  | "waiting"
  | "resumed"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";
type Chunk = {
  type: "task_update";
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
};
type Result = {
  id: string;
  status: string;
  connectionId: string;
  conversationId: string;
  messageTs: string | null;
  errorCode?: string | null;
  retryAfter?: number | null;
};
/** Structural optional extension: installation still works with the published SDK baseline. */
export interface ProgressResource {
  sendMessage(
    connectionId: string,
    options: {
      conversationId: string;
      text: string;
      threadTs?: string | null;
      idempotencyKey: string;
    },
  ): Promise<Result>;
  updateMessage(
    connectionId: string,
    conversationId: string,
    messageTs: string,
    text: string,
    options: { idempotencyKey: string },
  ): Promise<Result>;
  getAction(connectionId: string, actionId: string): Promise<Result>;
  getActionByKey?(connectionId: string, idempotencyKey: string): Promise<Result>;
  getOperation(connectionId: string, operationId: string): Promise<Result>;
  capabilities?(connectionId: string): Promise<{
    nativeTaskStreaming?: string;
    capabilities: Record<string, { scopesSatisfied: boolean }>;
  }>;
  startStream?(
    connectionId: string,
    conversationId: string,
    options: {
      threadTs: string;
      recipientUserId: string;
      recipientTeamId: string;
      chunks: Chunk[];
      idempotencyKey: string;
      taskDisplayMode: "timeline";
    },
  ): Promise<Result>;
  appendStream?(
    connectionId: string,
    conversationId: string,
    streamId: string,
    options: { chunks: Chunk[]; idempotencyKey: string },
  ): Promise<Result>;
  stopStream?(
    connectionId: string,
    conversationId: string,
    streamId: string,
    options: { chunks: Chunk[]; idempotencyKey: string },
  ): Promise<Result>;
  getOperationByKey?(connectionId: string, options: { idempotencyKey: string }): Promise<Result>;
}
type Effect = {
  kind: "start" | "send" | "append" | "stop" | "edit";
  revision: number;
  key: string;
  resultId?: string;
  terminal: boolean;
  polls?: number;
  lookups?: number;
  outcomeUnknown?: boolean;
};
type Entry = {
  route: ProgressRoute;
  mode?: "native" | "fallback";
  desired: Chunk;
  revision: number;
  applied: number;
  terminal: boolean;
  done?: boolean;
  finishedAt?: number;
  pending?: Effect;
  streamId?: string;
  messageTs?: string;
  retryAt?: number;
  retries?: number;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const originKey = (r: ProgressRoute) =>
  digest([
    r.identityId,
    r.connectionId,
    r.workspaceId,
    r.connectionGeneration ?? null,
    r.conversationId,
    r.threadTs,
    r.messageTs,
    r.actorId,
    r.sourceEventId,
  ]);
const unsupported = new Set([
  "not_supported",
  "unsupported_operation",
  "method_not_supported",
  "invalid_thread_ts",
  "not_allowed_token_type",
  "missing_scope",
  "feature_not_enabled",
]);

/** One durable progress surface per admitted source. Unknown dispatches are never replayed. */
export function createSlackProgress(options: {
  resource(route: ProgressRoute): Promise<ProgressResource>;
  path: string;
  warn?(message: string): void;
  authorize?(route: ProgressRoute, terminal: boolean): boolean | Promise<boolean>;
  recoverEvent?(route: ProgressRoute): Promise<ProgressEvent | undefined>;
}) {
  const warn = options.warn ?? (() => {});
  const tails = new Map<string, Promise<void>>();
  const intents = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const mine = new Set<string>();
  const observed = new Map<string, string>();
  let closing = false;
  function read(): Record<string, Entry> {
    try {
      const data = JSON.parse(fs.readFileSync(options.path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid journal");
      return data;
    } catch (error: any) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }
  function acquireLock(lock: string, depth = 0): () => void {
    if (depth > 16) throw new Error("Slack progress recovery lock is busy.");
    for (let attempt = 0; attempt < 4; attempt++) {
      const nonce = randomUUID(),
        temp = `${lock}.${nonce}.owner`;
      fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, nonce }), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      let acquired = false;
      try {
        fs.linkSync(temp, lock);
        acquired = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      } finally {
        fs.unlinkSync(temp);
      }
      if (acquired)
        return () => {
          if (JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce) fs.unlinkSync(lock);
        };
      const dead = () => {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0)
          throw new Error("Invalid progress lock owner");
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error: any) {
          if (error?.code === "ESRCH") return true;
          throw error;
        }
      };
      try {
        if (!dead()) throw new Error("Slack progress writer is busy.");
        // Reclaimers use the same PID-bearing atomic lock and can themselves recover.
        const release = acquireLock(`${lock}.recovery`, depth + 1);
        try {
          if (dead()) fs.unlinkSync(lock);
        } finally {
          release();
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    throw new Error("Slack progress writer changed during recovery.");
  }
  function mutate<T>(change: (rows: Record<string, Entry>) => T): T {
    fs.mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    const release = acquireLock(`${options.path}.lock`);
    try {
      const rows = read();
      const result = change(rows);
      const finished = Object.entries(rows)
        .filter(([, row]) => row.done)
        .sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0));
      for (const [key] of finished.slice(512)) delete rows[key];
      const temp = `${options.path}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: "wx", flush: true });
      fs.renameSync(temp, options.path);
      const dir = fs.openSync(dirname(options.path), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
      return result;
    } finally {
      release();
    }
  }
  function valid(id: string, entry: Entry): boolean {
    return Boolean(
      entry?.route?.sourceEventId &&
        entry.route.identityId &&
        entry.route.connectionId &&
        entry.route.workspaceId &&
        entry.route.conversationId &&
        entry.route.messageTs &&
        originKey(entry.route) === id &&
        entry.desired &&
        Number.isInteger(entry.revision),
    );
  }
  async function apply(id: string) {
    let entry = read()[id];
    if (!entry || !valid(id, entry) || entry.done) return;
    if (!entry.pending && entry.applied >= entry.revision) return;
    if (entry.pending?.outcomeUnknown || (entry.pending?.lookups ?? 0) >= 5) return;
    if ((entry.retryAt ?? 0) > Date.now()) {
      schedule(id, entry.retryAt! - Date.now());
      return;
    }
    if (options.authorize && !(await options.authorize(entry.route, entry.terminal))) return;
    if (entry.pending) mutate((rows) => {
      const pending = rows[id]?.pending;
      if (pending?.key === entry.pending?.key) pending!.lookups = (pending!.lookups ?? 0) + 1;
    });
    const slack = await options.resource(entry.route);
    if (!slack.sendMessage || !slack.updateMessage) return;
    // Reads may cross a Stop or ownership change; recheck immediately before dispatch below.
    if (entry.pending) {
      const p = entry.pending;
      let result: Result;
      if (p.kind === "send") {
        if (p.resultId) result = await slack.getAction(entry.route.connectionId, p.resultId);
        else if (slack.getActionByKey)
          result = await slack.getActionByKey(entry.route.connectionId, p.key);
        else return;
      } else if (p.resultId)
        result = await slack.getOperation(entry.route.connectionId, p.resultId);
      else if (slack.getOperationByKey)
        result = await slack.getOperationByKey(entry.route.connectionId, { idempotencyKey: p.key });
      else return;
      settle(id, p, result);
      entry = read()[id]!;
      if (entry.pending || entry.done) return;
    }
    if (entry.applied >= entry.revision) return;
    if (closing && !entry.streamId && !entry.messageTs) return;
    if (!entry.mode) {
      let native = Boolean(
        entry.route.threadTs &&
          /^T[A-Z0-9]+$/.test(entry.route.recipientTeamId ?? "") &&
          slack.startStream &&
          slack.appendStream &&
          slack.stopStream &&
          slack.getOperationByKey,
      );
      if (native) {
        try {
          const caps = await slack.capabilities?.(entry.route.connectionId);
          native =
            caps?.nativeTaskStreaming !== "missing_scope" &&
            caps?.capabilities.task_streaming?.scopesSatisfied === true;
        } catch {
          native = false;
        } // No write occurred: ordinary progress remains safe.
      }
      mutate((rows) => {
        if (rows[id] && !rows[id]!.mode) rows[id]!.mode = native ? "native" : "fallback";
      });
    }
    entry = read()[id]!;
    if (entry.pending || entry.done || entry.applied >= entry.revision) return;
    // Do not create a new card after its source has finished before any dispatch.
    if (entry.terminal && !entry.streamId && !entry.messageTs) {
      mutate((rows) => {
        rows[id]!.done = true;
        rows[id]!.finishedAt = Date.now();
      });
      return;
    }
    if (options.authorize && !(await options.authorize(entry.route, entry.terminal))) return;
    let effect: Effect | undefined;
    mutate((rows) => {
      const current = rows[id]!;
      if (current.pending || current.done || current.applied >= current.revision) return;
      const kind =
        current.mode === "native"
          ? !current.streamId
            ? "start"
            : current.terminal
              ? "stop"
              : "append"
          : current.messageTs
            ? "edit"
            : "send";
      effect = {
        kind,
        revision: current.revision,
        key: `openclaw:progress:${digest([id, current.revision, kind])}`,
        terminal: current.terminal,
      };
      current.pending = effect;
      entry = structuredClone(current);
    });
    if (!effect) return;
    const r = entry.route,
      chunks = [entry.desired],
      opts = { idempotencyKey: effect.key };
    let result: Result;
    // From this checkpoint onward every thrown error is uncertain; only a definitive result permits fallback.
    if (effect.kind === "start")
      result = await slack.startStream!(r.connectionId, r.conversationId, {
        ...opts,
        threadTs: r.threadTs!,
        recipientUserId: r.actorId,
        recipientTeamId: r.recipientTeamId!,
        chunks,
        taskDisplayMode: "timeline",
      });
    else if (effect.kind === "append")
      result = await slack.appendStream!(r.connectionId, r.conversationId, entry.streamId!, {
        ...opts,
        chunks,
      });
    else if (effect.kind === "stop")
      result = await slack.stopStream!(r.connectionId, r.conversationId, entry.streamId!, {
        ...opts,
        chunks,
      });
    else if (effect.kind === "send")
      result = await slack.sendMessage(r.connectionId, {
        ...opts,
        conversationId: r.conversationId,
        threadTs: r.threadTs,
        text: entry.desired.title,
      });
    else
      result = await slack.updateMessage(
        r.connectionId,
        r.conversationId,
        entry.messageTs!,
        entry.desired.title,
        opts,
      );
    settle(id, effect, result);
    const latest = read()[id];
    if (latest && !latest.pending && !latest.done && latest.applied < latest.revision) schedule(id);
  }
  function settle(id: string, effect: Effect, result: Result) {
    mutate((rows) => {
      const entry = rows[id];
      if (!entry || entry.pending?.key !== effect.key) return;
      if (
        result.connectionId !== entry.route.connectionId ||
        result.conversationId !== entry.route.conversationId
      )
        return;
      if (result.status === (effect.kind === "send" ? "sent" : "succeeded")) {
        if ((effect.kind === "send" || effect.kind === "start") && !result.messageTs) return;
        if (effect.kind === "start") entry.streamId = result.id;
        if (effect.kind === "send") entry.messageTs = result.messageTs!;
        entry.applied = effect.revision;
        delete entry.pending;
        if (effect.terminal) {
          entry.done = true;
          entry.finishedAt = Date.now();
        }
      } else if (result.status === "failed") {
        delete entry.pending;
        if (effect.kind === "start" && unsupported.has(result.errorCode ?? "")) {
          entry.mode = "fallback";
          // Same desired state but a different operation family/key; native is definitively absent.
        } else {
          entry.applied = effect.revision;
          entry.retryAt = Date.now() + Math.max(1000, (result.retryAfter ?? 1) * 1000);
          if (
            effect.terminal &&
            (entry.retries ?? 0) < 2 &&
            ["rate_limited", "ratelimited", "connection_failed"].includes(result.errorCode ?? "")
          ) {
            entry.retries = (entry.retries ?? 0) + 1;
            entry.revision += 1;
          } else if (effect.terminal) {
            entry.done = true;
            entry.finishedAt = Date.now();
          }
          warn("Slack progress was rejected; the final reply is unaffected.");
        }
      } else {
        if (result.id) entry.pending.resultId = result.id;
        if (result.status === "unknown") entry.pending.outcomeUnknown = true;
        if (["sending", "in_progress"].includes(result.status) && (entry.pending.polls ?? 0) < 5) {
          entry.pending.polls = (entry.pending.polls ?? 0) + 1;
          schedule(id, 1000);
        }
        warn("Slack progress is unconfirmed; it will not be resent.");
      }
    });
  }
  function schedule(id: string, delay = 250) {
    if (timers.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      run(id);
    }, delay);
    timer.unref?.();
    timers.set(id, timer);
  }
  function run(id: string) {
    const prior = tails.get(id) ?? Promise.resolve();
    const task = prior
      .then(() => apply(id))
      .catch(() => warn("Slack progress is unavailable; the final reply is unaffected."));
    tails.set(id, task);
    void task.finally(() => {
      if (tails.get(id) === task) tails.delete(id);
    });
  }
  function desired(route: ProgressRoute, chunk: Chunk, terminal: boolean, admit = false) {
    if (closing) return;
    const id = originKey(route);
    try {
      const existing = read()[id];
      if ((!admit && !existing && !intents.has(id)) || existing?.done || existing?.terminal) return;
    } catch {
      warn("Slack progress journal cannot be read; no update was sent.");
      return;
    }
    const task = (intents.get(id) ?? Promise.resolve())
      .then(async () => {
        if (options.authorize && !(await options.authorize(route, terminal))) return;
        mutate((rows) => {
          let entry = rows[id];
          if (!entry && admit) {
            const {
              identityId,
              connectionGeneration,
              recipientTeamId,
              connectionId,
              workspaceId,
              conversationId,
              actorId,
              author,
              messageTs,
              threadTs,
              sourceEventId,
            } = route;
            entry = rows[id] = {
              route: {
                identityId,
                connectionGeneration,
                recipientTeamId,
                connectionId,
                workspaceId,
                conversationId,
                actorId,
                author,
                messageTs,
                threadTs,
                sourceEventId,
              },
              desired: chunk,
              revision: 1,
              applied: 0,
              terminal: false,
            };
          }
          if (!entry || entry.terminal || entry.done) return;
          mine.add(id);
          if (JSON.stringify(entry.desired) !== JSON.stringify(chunk) || terminal) {
            entry.desired = chunk;
            entry.revision += 1;
          }
          entry.terminal = terminal;
        });
        schedule(id);
      })
      .catch(() => warn("Slack progress could not be saved; no update was sent."));
    intents.set(id, task);
    void task.finally(() => {
      if (intents.get(id) === task) intents.delete(id);
    });
  }
  return {
    notify(route: ProgressRoute, event: ProgressEvent) {
      const titles = {
        accepted: "Working…",
        resumed: "Working…",
        waiting: "Waiting for your approval…",
        completed: "Completed",
        failed: "Work stopped with an error",
        cancelled: "Stopped",
        paused: "Paused; prior work is unconfirmed",
      };
      const terminal = ["completed", "failed", "cancelled"].includes(event);
      desired(
        route,
        {
          type: "task_update",
          id: "work",
          title: titles[event],
          status: event === "failed" ? "error" : terminal ? "complete" : "in_progress",
        },
        terminal,
        event === "accepted",
      );
    },
    observe(
      route: ProgressRoute,
      update: { tool: string; status: "running" | "completed" | "error"; id: string },
    ) {
      const observation = `${originKey(route)}:${update.id}`;
      if (observed.get(observation) === update.status) return;
      observed.set(observation, update.status);
      // Fixed vocabulary: never display host/model-provided summaries or arbitrary tool names.
      const tool = update.tool.toLowerCase();
      const title = /^(read|glob|grep|inkbox_.*(list|get|search).*)$/.test(tool)
        ? "Reading information…"
        : /^(write|edit|apply_patch)$/.test(tool)
          ? "Updating files…"
          : /^(bash|shell|exec)$/.test(tool)
            ? "Running a check…"
            : /^(task|delegate.*)$/.test(tool)
              ? "Working on a subtask…"
              : "Using a tool…";
      desired(
        route,
        {
          type: "task_update",
          id: "work",
          title:
            update.status === "running"
              ? title
              : update.status === "error"
                ? "A tool failed; checking the next step…"
                : "Continuing…",
          status: "in_progress",
        },
        false,
      );
    },
    async recover() {
      try {
        const rows = read(); // Load/validate the complete journal before any cleanup writes.
        for (const [id, entry] of Object.entries(rows)) {
          if (!valid(id, entry) || entry.done) continue;
          const event = await options.recoverEvent?.(entry.route);
          if (event) this.notify(entry.route, event);
          if (!options.authorize || (await options.authorize(entry.route, entry.terminal))) {
            mine.add(id);
            run(id);
          }
        }
        await this.flush();
      } catch {
        warn("Slack progress recovery is unavailable; no new card was created.");
      }
    },
    async flush() {
      while (intents.size) await Promise.all([...intents.values()]);
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        timers.delete(id);
        run(id);
      }
      while (tails.size) await Promise.all([...tails.values()]);
    },
    async close() {
      while (intents.size) await Promise.all([...intents.values()]);
      try {
        const rows = read();
        for (const id of mine) {
          const entry = rows[id];
          if (entry && !entry.terminal && (entry.streamId || entry.messageTs || entry.pending))
            desired(
              entry.route,
              {
                type: "task_update",
                id: "work",
                title: "Paused while reconnecting…",
                status: "in_progress",
              },
              false,
            );
        }
      } catch {
        warn("Slack progress cleanup is unavailable; shutdown will continue.");
      }
      closing = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
