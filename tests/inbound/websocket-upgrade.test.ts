import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createInkboxWebSocketUpgradeHandler } from "../../src/inbound/websocket-upgrade.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function listen(
  handleUpgrade: ReturnType<typeof createInkboxWebSocketUpgradeHandler>,
): Promise<string> {
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

describe("createInkboxWebSocketUpgradeHandler", () => {
  it("defers acceptance, preserves signed request metadata, and bridges frames", async () => {
    const seen = vi.fn();
    const handleUpgrade = createInkboxWebSocketUpgradeHandler({
      publicWebsocketUrl: "wss://voice.example/inkbox/media/phone/media/ws",
      handler: async (socket) => {
        seen({
          url: socket.url,
          context: socket.headers.get("x-call-context"),
          protocols: socket.offeredProtocols,
        });
        await socket.accept({
          protocol: "inkbox-call",
          headers: [["x-use-inkbox-text-to-speech", "true"]],
        });
        const first = await socket[Symbol.asyncIterator]().next();
        await socket.send(`echo:${first.value}`);
        await socket.close(1000, "done");
      },
    });
    const base = await listen(handleUpgrade);
    const client = new WebSocket(
      `${base}/inkbox/media/phone/media/ws?call_id=call-1`,
      "inkbox-call",
      { headers: { "x-call-context": "signed-context" } },
    );
    const responseHeader = new Promise<string | string[] | undefined>((resolve) => {
      client.once("upgrade", (response) =>
        resolve(response.headers["x-use-inkbox-text-to-speech"]),
      );
    });
    const echoed = new Promise<string>((resolve, reject) => {
      client.once("open", () => client.send("hello"));
      client.once("message", (data) => resolve(data.toString()));
      client.once("error", reject);
    });

    await expect(responseHeader).resolves.toBe("true");
    await expect(echoed).resolves.toBe("echo:hello");
    expect(client.protocol).toBe("inkbox-call");
    expect(seen).toHaveBeenCalledWith({
      url: "wss://voice.example/inkbox/media/phone/media/ws?call_id=call-1",
      context: "signed-context",
      protocols: ["inkbox-call"],
    });
  });

  it("rejects before upgrading when the bridge closes an unaccepted socket", async () => {
    const handleUpgrade = createInkboxWebSocketUpgradeHandler({
      publicWebsocketUrl: "wss://voice.example/inkbox/phone/media/ws",
      handler: async (socket) => {
        await socket.close(1008, "invalid signature");
      },
    });
    const base = await listen(handleUpgrade);
    const client = new WebSocket(`${base}/inkbox/phone/media/ws`);

    const status = await new Promise<number>((resolve, reject) => {
      client.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      client.once("error", reject);
    });
    expect(status).toBe(403);
  });

  it("does not select an offered protocol unless the bridge requests it", async () => {
    const handleUpgrade = createInkboxWebSocketUpgradeHandler({
      publicWebsocketUrl: "wss://voice.example/inkbox/phone/media/ws",
      handler: async (socket) => {
        await socket.accept();
        await socket.close(1000, "done");
      },
    });
    const base = await listen(handleUpgrade);
    const client = new WebSocket(
      `${base}/inkbox/phone/media/ws`,
      "offered-but-not-selected",
    );
    client.on("error", () => undefined);
    const selectedProtocol = await new Promise<string | string[] | undefined>((resolve) => {
      client.once("upgrade", (response) =>
        resolve(response.headers["sec-websocket-protocol"]),
      );
    });
    expect(selectedProtocol).toBeUndefined();
  });

  it("fails closed when the bridge returns without accepting", async () => {
    const handleUpgrade = createInkboxWebSocketUpgradeHandler({
      publicWebsocketUrl: "wss://voice.example/inkbox/phone/media/ws",
      handler: async () => undefined,
    });
    const base = await listen(handleUpgrade);
    const client = new WebSocket(`${base}/inkbox/phone/media/ws`);

    const status = await new Promise<number>((resolve, reject) => {
      client.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      client.once("error", reject);
    });
    expect(status).toBe(403);
  });

  it("settles pending readers when acceptance fails", async () => {
    let pendingRead: Promise<unknown> | undefined;
    const handleUpgrade = createInkboxWebSocketUpgradeHandler({
      publicWebsocketUrl: "wss://voice.example/inkbox/phone/media/ws",
      handler: async (socket) => {
        pendingRead = socket[Symbol.asyncIterator]().next();
        void pendingRead.catch(() => undefined);
        await socket.accept({ protocol: "not-offered" });
      },
    });
    const base = await listen(handleUpgrade);
    const client = new WebSocket(`${base}/inkbox/phone/media/ws`);
    client.on("error", () => undefined);

    const status = await new Promise<number>((resolve) => {
      client.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
    });
    expect(status).toBe(403);
    await expect(pendingRead).rejects.toThrow("was not offered");
  });
});
