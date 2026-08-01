import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  InkboxWebSocket,
  InkboxWebSocketAcceptOpts,
  InkboxWsHandler,
} from "@inkbox/sdk/tunnels/connect";
import { WebSocket, WebSocketServer } from "ws";
import type { PluginLogger } from "../client.js";

type InboundFrame = string | Buffer;
type PendingRead = {
  resolve(result: IteratorResult<InboundFrame>): void;
  reject(error: unknown): void;
};

function requestHeaders(req: IncomingMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(name.toLowerCase(), value.join(", "));
    } else if (value !== undefined) {
      headers.set(name.toLowerCase(), value);
    }
  }
  return headers;
}

function offeredProtocols(req: IncomingMessage): string[] {
  const value = req.headers["sec-websocket-protocol"];
  const joined = Array.isArray(value) ? value.join(",") : value;
  return (joined ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeResponseHeader([name, value]: [string, string]): string | undefined {
  if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name) || /[\r\n]/u.test(value)) {
    return undefined;
  }
  const lower = name.toLowerCase();
  if (
    lower === "connection" ||
    lower === "upgrade" ||
    lower === "sec-websocket-accept" ||
    lower === "sec-websocket-protocol"
  ) {
    return undefined;
  }
  return `${name}: ${value}`;
}

class DeferredNodeInkboxWebSocket implements InkboxWebSocket {
  readonly headers: ReadonlyMap<string, string>;
  readonly offeredProtocols: ReadonlyArray<string>;
  private socket: WebSocket | undefined;
  private acceptPromise: Promise<void> | undefined;
  private ended = false;
  private terminalError: unknown;
  private readonly queued: InboundFrame[] = [];
  private readonly pending: PendingRead[] = [];

  get handshakeSettled(): boolean {
    return Boolean(this.acceptPromise) || this.ended;
  }

  constructor(
    readonly url: string,
    private readonly req: IncomingMessage,
    private readonly rawSocket: Duplex,
    private readonly head: Buffer,
  ) {
    this.headers = requestHeaders(req);
    this.offeredProtocols = offeredProtocols(req);
  }

  async accept(opts?: InkboxWebSocketAcceptOpts): Promise<void> {
    if (this.acceptPromise) {
      return await this.acceptPromise;
    }
    if (this.ended) {
      throw new Error("WebSocket is already closed");
    }
    const protocol = opts?.protocol;
    if (protocol && !this.offeredProtocols.includes(protocol)) {
      const error = new Error(`Requested WebSocket protocol ${protocol} was not offered`);
      this.finish(error);
      throw error;
    }
    this.acceptPromise = new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        handleProtocols: () => protocol || false,
      });
      server.once("headers", (headers) => {
        for (const header of opts?.headers ?? []) {
          const safe = safeResponseHeader(header);
          if (safe) headers.push(safe);
        }
      });
      try {
        server.handleUpgrade(this.req, this.rawSocket, this.head, (socket) => {
          this.socket = socket;
          socket.on("message", (data, isBinary) => {
            const frame = isBinary ? Buffer.from(data as any) : data.toString();
            const waiter = this.pending.shift();
            if (waiter) waiter.resolve({ value: frame, done: false });
            else this.queued.push(frame);
          });
          socket.once("close", () => this.finish());
          socket.once("error", (error) => this.finish(error));
          resolve();
        });
      } catch (error) {
        this.finish(error);
        this.rawSocket.destroy();
        reject(error);
      }
    });
    return await this.acceptPromise;
  }

  async send(data: string | Buffer): Promise<void> {
    await this.acceptPromise;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is closed");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (!this.acceptPromise) {
      this.ended = true;
      if (!this.rawSocket.destroyed) {
        this.rawSocket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
      this.finish();
      return;
    }
    await this.acceptPromise.catch(() => undefined);
    this.socket?.close(code, reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundFrame> {
    return {
      next: async () => {
        if (this.queued.length > 0) {
          return { value: this.queued.shift()!, done: false };
        }
        if (this.terminalError) throw this.terminalError;
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<InboundFrame>>((resolve, reject) => {
          this.pending.push({ resolve, reject });
        });
      },
    };
  }

  private finish(error?: unknown): void {
    if (this.ended && !error && this.pending.length === 0) return;
    this.ended = true;
    this.terminalError = error;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()!;
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
}

export function createInkboxWebSocketUpgradeHandler(opts: {
  handler: InkboxWsHandler;
  publicWebsocketUrl: string;
  logger?: PluginLogger;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  return (req, socket, head) => {
    const incoming = new URL(req.url ?? "/", "http://openclaw.invalid");
    const url = new URL(opts.publicWebsocketUrl);
    url.search = incoming.search;
    const ws = new DeferredNodeInkboxWebSocket(url.toString(), req, socket, head);
    void opts.handler(ws).then(
      () => {
        if (!ws.handshakeSettled) {
          opts.logger?.warn?.("Inkbox call WebSocket handler returned without accepting");
          void ws.close(1008, "call not accepted");
        }
      },
      (error) => {
        opts.logger?.warn?.(
          `Inkbox call WebSocket handler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        void ws.close(1011, "call handler failed");
      },
    );
    return true;
  };
}
