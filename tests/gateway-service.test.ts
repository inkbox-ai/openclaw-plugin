import { describe, expect, it, vi } from "vitest";
import {
  detectGatewayState,
  hostCommandPrefix,
  offerGatewayRestart,
  parseGatewayStatus,
  printReadyBanner,
  waitForGatewayRunning,
  type GatewayCommandRunner,
} from "../src/gateway-service.js";
import type { Prompter } from "../src/prompt.js";

function createPrompter(confirms: boolean[] = []): Prompter & { confirm: ReturnType<typeof vi.fn> } {
  const queue = [...confirms];
  return {
    ask: vi.fn(async () => ""),
    confirm: vi.fn(async (_question: string, defaultYes?: boolean) =>
      queue.length ? queue.shift()! : Boolean(defaultYes),
    ),
    close: vi.fn(),
  };
}

// Skip the real inter-poll delay and the 15s start-confirmation window.
const noSleep = async (): Promise<void> => {};
const fastConfirm = { sleep: noSleep, confirmTimeoutMs: 0 };

function statusJson(params: { running?: boolean; loaded?: boolean; pid?: number }): string {
  return JSON.stringify({
    service: {
      label: "openclaw.gateway",
      loaded: params.loaded ?? false,
      runtime: {
        ...(params.running ? { status: "running" } : { status: "stopped" }),
        ...(params.pid ? { pid: params.pid } : {}),
      },
    },
  });
}

// Returns a runner that answers `gateway status` from `statuses` (in order)
// and records every lifecycle action it is asked to run.
function createRunner(statuses: string[], lifecycleCode = 0) {
  const queue = [...statuses];
  const actions: string[] = [];
  const run: GatewayCommandRunner = vi.fn((args) => {
    if (args[1] === "status") {
      return { code: 0, stdout: queue.shift() ?? "", stderr: "" };
    }
    actions.push(args[1]);
    return { code: lifecycleCode, stdout: "", stderr: lifecycleCode ? "boom" : "" };
  });
  return { run, actions };
}

describe("parseGatewayStatus", () => {
  it("reads liveness and install state from the host status document", () => {
    expect(parseGatewayStatus(statusJson({ running: true, loaded: true }))).toEqual({
      running: true,
      serviceInstalled: true,
    });
    expect(parseGatewayStatus(statusJson({ running: false, loaded: true }))).toEqual({
      running: false,
      serviceInstalled: true,
    });
  });

  it("treats a live pid as running even without a status string", () => {
    const doc = JSON.stringify({ service: { loaded: true, runtime: { pid: 4242 } } });
    expect(parseGatewayStatus(doc)).toEqual({ running: true, serviceInstalled: true });
  });

  it("recovers JSON that is preceded by warning output", () => {
    const noisy = `warning: config is stale\n${statusJson({ running: true, loaded: true })}`;
    expect(parseGatewayStatus(noisy)?.running).toBe(true);
  });

  it("returns null for unusable output", () => {
    expect(parseGatewayStatus("")).toBeNull();
    expect(parseGatewayStatus("command not found")).toBeNull();
    expect(parseGatewayStatus(JSON.stringify({ ok: true }))).toBeNull();
  });
});

describe("detectGatewayState", () => {
  it("reports unknown when the host CLI cannot be run", () => {
    const run: GatewayCommandRunner = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(detectGatewayState(run)).toEqual({ running: null, serviceInstalled: false });
  });

  it("reports unknown when the CLI writes nothing parseable", () => {
    const run: GatewayCommandRunner = vi.fn(() => ({ code: 1, stdout: "", stderr: "nope" }));
    expect(detectGatewayState(run)).toEqual({ running: null, serviceInstalled: false });
  });

  it("asks for JSON without the RPC probe", () => {
    const { run } = createRunner([statusJson({ running: true, loaded: true })]);
    detectGatewayState(run);
    expect(run).toHaveBeenCalledWith(
      ["gateway", "status", "--json", "--no-probe"],
      expect.objectContaining({ capture: true }),
    );
  });
});

describe("hostCommandPrefix", () => {
  it("re-invokes the entry script running this process", () => {
    expect(hostCommandPrefix(["/usr/bin/node", "/opt/openclaw/openclaw.mjs"], "/usr/bin/node")).toEqual(
      ["/usr/bin/node", "/opt/openclaw/openclaw.mjs"],
    );
  });

  it("falls back to the CLI name when there is no entry script", () => {
    expect(hostCommandPrefix(["/usr/bin/node"], "/usr/bin/node")).toEqual(["openclaw"]);
  });
});

describe("offerGatewayRestart", () => {
  it("restarts a running gateway", async () => {
    const { run, actions } = createRunner([statusJson({ running: true, loaded: true })]);
    const prompter = createPrompter([true]);

    await expect(offerGatewayRestart(prompter, run)).resolves.toBe(true);

    expect(actions).toEqual(["restart"]);
    expect(prompter.confirm).toHaveBeenCalledWith("Restart the gateway now?", true);
  });

  it("still reports live when the restart is declined", async () => {
    const { run, actions } = createRunner([statusJson({ running: true, loaded: true })]);

    await expect(offerGatewayRestart(createPrompter([false]), run)).resolves.toBe(true);

    expect(actions).toEqual([]);
  });

  it("starts an installed-but-stopped gateway", async () => {
    const { run, actions } = createRunner([statusJson({ running: false, loaded: true })]);

    await expect(offerGatewayRestart(createPrompter([true]), run)).resolves.toBe(true);

    expect(actions).toEqual(["start"]);
  });

  it("installs when there is no service slot, then confirms liveness", async () => {
    const { run, actions } = createRunner([
      statusJson({ running: false, loaded: false }),
      statusJson({ running: true, loaded: true }),
    ]);

    await expect(offerGatewayRestart(createPrompter([true]), run, fastConfirm)).resolves.toBe(true);

    expect(actions).toEqual(["install"]);
  });

  it("never tells the operator to start one when install is unconfirmed", async () => {
    // `install` can come up as a plain background process when the platform's
    // service manager refuses the bootstrap. Telling the operator to start
    // another one on top of that would duplicate the gateway.
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((msg) => void lines.push(String(msg)));
    const { run, actions } = createRunner([statusJson({ running: false, loaded: false })]);

    await expect(offerGatewayRestart(createPrompter([true]), run, fastConfirm)).resolves.toBe(true);

    expect(actions).toEqual(["install"]);
    const output = lines.join("\n");
    expect(output).toContain("openclaw gateway status");
    expect(output).not.toContain("openclaw gateway start");
    expect(output).not.toContain("openclaw gateway run");
    log.mockRestore();
  });

  it("runs nothing when the install offer is declined", async () => {
    const { run, actions } = createRunner([statusJson({ running: false, loaded: false })]);

    await expect(offerGatewayRestart(createPrompter([false]), run)).resolves.toBe(false);

    expect(actions).toEqual([]);
  });

  it("reports not-live when a lifecycle command fails", async () => {
    const { run, actions } = createRunner(
      [statusJson({ running: false, loaded: false }), statusJson({ running: false, loaded: false })],
      1,
    );

    await expect(offerGatewayRestart(createPrompter([true]), run, fastConfirm)).resolves.toBe(false);

    expect(actions).toEqual(["install"]);
  });

  it("asks nothing when gateway state is unknown", async () => {
    const run: GatewayCommandRunner = vi.fn(() => ({ code: 1, stdout: "", stderr: "" }));
    const prompter = createPrompter();

    await expect(offerGatewayRestart(prompter, run)).resolves.toBe(false);

    expect(prompter.confirm).not.toHaveBeenCalled();
  });
});

describe("waitForGatewayRunning", () => {
  it("keeps polling until the gateway becomes visible", async () => {
    // A gateway is not visible to `gateway status` until it finishes claiming
    // its runtime state, so the first probe after a start can miss it.
    const { run } = createRunner([
      statusJson({ running: false, loaded: true }),
      statusJson({ running: false, loaded: true }),
      statusJson({ running: true, loaded: true }),
    ]);

    await expect(waitForGatewayRunning(run, 30_000, noSleep)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("gives up at the timeout", async () => {
    const { run } = createRunner([statusJson({ running: false, loaded: true })]);

    await expect(waitForGatewayRunning(run, 0, noSleep)).resolves.toBe(false);
    // Timeout 0 still probes once before giving up.
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("printReadyBanner", () => {
  function render(handle: string): string[] {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((msg) => void lines.push(String(msg)));
    printReadyBanner(handle);
    log.mockRestore();
    return lines.filter(Boolean);
  }

  it("names the identity and the health command", () => {
    const lines = render("smoke-agent");
    const output = lines.join("\n");
    expect(output).toContain("smoke-agent");
    expect(output).toContain("openclaw inkbox doctor");
  });

  it("keeps the box square for short and long handles", () => {
    for (const handle of ["a", "a-very-long-agent-handle-that-sets-the-width"]) {
      const widths = new Set(render(handle).map((line) => line.length));
      expect(widths.size).toBe(1);
    }
  });
});
