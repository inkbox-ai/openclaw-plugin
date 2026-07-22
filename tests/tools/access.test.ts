import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { registerIdentityAccessTools } from "../../src/tools/access.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): {
  api: any;
  tools: Map<string, RegisteredTool>;
  options: Map<string, any>;
} {
  const tools = new Map<string, RegisteredTool>();
  const options = new Map<string, any>();
  const api = {
    registerTool: (def: RegisteredTool, opts?: any) => {
      tools.set(def.name, def);
      options.set(def.name, opts);
    },
  };
  return { api, tools, options };
}

function createRuntime(access: { notes?: any }): InkboxRuntime {
  return {
    getIdentity: () => Promise.resolve({} as any),
    getClient: () =>
      Promise.resolve({
        notes: { access: access.notes ?? {} },
      } as any),
  };
}

describe("registerIdentityAccessTools", () => {
  it("grants note access to a specific identity", async () => {
    const { api, tools } = createApi();
    const grant = vi.fn().mockResolvedValue({ identityId: "identity-1" });
    registerIdentityAccessTools(api, createRuntime({ notes: { grant } }));

    const out = await tools.get("inkbox_grant_note_access")!.execute("turn-1", {
      noteId: "note-1",
      identityId: "identity-1",
    });

    expect(grant).toHaveBeenCalledWith("note-1", "identity-1");
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("identity-1");
  });
});
