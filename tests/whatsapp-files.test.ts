import { mkdtemp, readFile, rm, stat, writeFile, mkdir, truncate, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return {
    statePaths: () => ({ dir: state.dir }),
    ensureStateDir: () => fs.mkdir(state.dir, { recursive: true, mode: 0o700 }),
  };
});
import {
  whatsappAttachments,
  whatsappFile,
  WHATSAPP_MAX_BYTES,
  WHATSAPP_MEDIA_CACHE_BYTES,
} from "../src/whatsapp.js";
beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "inkbox-wa-files-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(state.dir, { recursive: true, force: true });
});
describe("owned WhatsApp attachment bytes", () => {
  it("refreshes access by owned ID, downloads bounded bytes without credentials, and saves private local data", async () => {
    const getWhatsAppMedia = vi.fn(async () => ({
      id: "media-a",
      filename: "brief.pdf",
      contentType: "application/pdf",
      size: 5,
      status: "ready",
      url: "https://example.test/current",
    }));
    const identity = { id: "identity-a", getWhatsAppMedia };
    const fetcher = vi.fn(async () => new Response("brief"));
    vi.stubGlobal("fetch", fetcher);
    const result = await whatsappAttachments(
      { getIdentity: async () => identity } as any,
      {
        agent_identity_id: "identity-a",
        media: [
          {
            id: "media-a",
            filename: "brief.pdf",
            content_type: "application/pdf",
            size: 5,
            status: "ready",
            url: "https://example.test/expired",
          },
        ],
      },
    );
    expect(getWhatsAppMedia).toHaveBeenCalledWith("media-a");
    expect(fetcher.mock.calls[0][0]).toBe("https://example.test/current");
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    const path = result[0].local_path as string;
    expect(await readFile(path, "utf8")).toBe("brief");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("keeps unavailable and oversized media explicit without reading unbounded bytes", async () => {
    const identity = {
      id: "identity-a",
      getWhatsAppMedia: vi.fn(async () => ({
        id: "media-a",
        status: "ready",
        size: WHATSAPP_MAX_BYTES + 1,
        url: "https://example.test/large",
      })),
    };
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const rows = await whatsappAttachments(
      { getIdentity: async () => identity } as any,
      {
        agent_identity_id: "identity-a",
        media: [
          {
            id: "media-a",
            filename: "large.bin",
            content_type: "application/octet-stream",
          },
        ],
      },
    );
    expect(rows[0].unavailable).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      whatsappAttachments({ getIdentity: async () => identity } as any, {
        agent_identity_id: "foreign",
        media: [],
      }),
    ).rejects.toThrow(/identity mismatch/);
  });
  it("uploads actual bounded regular-file bytes and rejects URL-shaped or oversized inputs", async () => {
    const path = join(state.dir, "brief.txt");
    await writeFile(path, "brief");
    expect((await whatsappFile(path)).content.toString()).toBe("brief");
    await expect(whatsappFile("https://example.test/file")).rejects.toThrow(
      /local regular/,
    );
    await writeFile(path, Buffer.alloc(WHATSAPP_MAX_BYTES + 1));
    await expect(whatsappFile(path)).rejects.toThrow(/20 MiB/);
  });
  it("expires old cache bytes and refuses new bytes when fresh retained files fill the bound", async () => {
    const directory = join(state.dir, "whatsapp-media"); await mkdir(directory);
    const retained = join(directory, "a".repeat(64)); await writeFile(retained, ""); await truncate(retained, WHATSAPP_MEDIA_CACHE_BYTES);
    const identity = { id: "identity-a", getWhatsAppMedia: async () => ({ id: "media-a", status: "ready", size: 5, url: "https://example.test/file" }) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("brief")));
    const message = { agent_identity_id: "identity-a", media: [{ id: "media-a", filename: "brief.txt", content_type: "text/plain" }] };
    expect((await whatsappAttachments({ getIdentity: async () => identity } as any, message))[0].unavailable).toBe(true);
    expect((await stat(retained)).size).toBe(WHATSAPP_MEDIA_CACHE_BYTES);
    await utimes(retained, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));
    const downloaded = await whatsappAttachments({ getIdentity: async () => identity } as any, message);
    expect(await readFile(downloaded[0].local_path as string, "utf8")).toBe("brief");
    await expect(stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
  });

});
