import { spawnSync } from "node:child_process";
import type { Prompter } from "./prompt.js";

// Liveness of the host gateway service, as reported by the host CLI.
export interface GatewayServiceState {
  // null when the CLI could not be asked (missing, errored, unparseable output).
  running: boolean | null;
  serviceInstalled: boolean;
}

export interface GatewayCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GatewayCommandRunner = (
  args: string[],
  opts: { timeoutMs?: number; capture?: boolean },
) => GatewayCommandResult;

const STATUS_TIMEOUT_MS = 20_000;
// A restart drains active gateway work before coming back up, and `install`
// can compile a service unit, so give the lifecycle actions real room.
const LIFECYCLE_TIMEOUT_MS = 180_000;
// A freshly started gateway is not visible to `gateway status` until it has
// finished claiming its runtime state, so confirm by polling, not one probe.
const START_CONFIRM_TIMEOUT_MS = 15_000;
const START_CONFIRM_POLL_MS = 1_000;

// Re-invoke the entry script running this wizard rather than trusting PATH,
// mirroring how the host shells back into its own `gateway` commands.
export function hostCommandPrefix(argv = process.argv, execPath = process.execPath): string[] {
  const entry = argv[1];
  return entry ? [execPath, entry] : ["openclaw"];
}

export const defaultGatewayCommandRunner: GatewayCommandRunner = (args, opts) => {
  const [command, ...prefix] = hostCommandPrefix();
  const capture = opts.capture ?? false;
  const res = spawnSync(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    // Lifecycle actions print their own progress and may prompt; only the
    // status probe needs its output captured.
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

export function parseGatewayStatus(stdout: string): GatewayServiceState | null {
  const doc = parseJsonDocument(stdout);
  const service = (doc as { service?: Record<string, unknown> } | null)?.service;
  if (!service || typeof service !== "object") {
    return null;
  }
  const runtime = (service as { runtime?: { status?: string; pid?: number } }).runtime;
  const pid = typeof runtime?.pid === "number" ? runtime.pid : 0;
  return {
    running: runtime?.status === "running" || pid > 0,
    serviceInstalled: Boolean((service as { loaded?: boolean }).loaded),
  };
}

// `--json` output can be preceded by warnings, so retry from the first brace.
function parseJsonDocument(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

export function detectGatewayState(run: GatewayCommandRunner): GatewayServiceState {
  let res: GatewayCommandResult;
  try {
    res = run(["gateway", "status", "--json", "--no-probe"], {
      timeoutMs: STATUS_TIMEOUT_MS,
      capture: true,
    });
  } catch {
    return { running: null, serviceInstalled: false };
  }
  // A non-zero exit still carries usable JSON in some states, so parse first
  // and only give up when there is nothing to read.
  return parseGatewayStatus(res.stdout) ?? { running: null, serviceInstalled: false };
}

function runLifecycle(run: GatewayCommandRunner, action: string): boolean {
  let res: GatewayCommandResult;
  try {
    res = run(["gateway", action], { timeoutMs: LIFECYCLE_TIMEOUT_MS });
  } catch (error) {
    console.log(`  \`openclaw gateway ${action}\` failed: ${String(error)}`);
    return false;
  }
  if (res.code === 0) return true;
  const detail = (res.stderr || res.stdout).trim().split("\n").filter(Boolean).pop();
  console.log(`  \`openclaw gateway ${action}\` exited ${res.code}.`);
  if (detail) console.log(`    ${detail}`);
  return false;
}

/**
 * Poll for gateway liveness after a start or install.
 *
 * @param run - Host-CLI runner.
 * @param timeoutMs - How long to keep polling before giving up.
 * @param sleep - Injectable delay so tests do not wait in real time.
 * @returns True once a gateway reports running. A single immediate probe
 *   races a gateway that is still coming up, so poll rather than ask once.
 */
export async function waitForGatewayRunning(
  run: GatewayCommandRunner,
  timeoutMs: number = START_CONFIRM_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (detectGatewayState(run).running) return true;
    if (Date.now() >= deadline) return false;
    await sleep(START_CONFIRM_POLL_MS);
  }
}

/**
 * Offer to restart (or start, or install) the gateway so the config this
 * wizard just wrote actually takes effect.
 *
 * @param prompter - Prompter used for the yes/no questions.
 * @param run - Host-CLI runner; injectable so tests never spawn a process.
 * @param opts - Start-confirmation knobs, injectable so tests do not wait.
 * @returns True when the caller should NOT tell the operator to start a
 *   gateway - either one is confirmed running, or a start/install we ran
 *   reported success and a second one would duplicate it.
 */
export async function offerGatewayRestart(
  prompter: Prompter,
  run: GatewayCommandRunner = defaultGatewayCommandRunner,
  opts: { sleep?: (ms: number) => Promise<void>; confirmTimeoutMs?: number } = {},
): Promise<boolean> {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? START_CONFIRM_TIMEOUT_MS;
  console.log("\nOpenClaw gateway:");

  const { running, serviceInstalled } = detectGatewayState(run);

  if (running === null) {
    console.log("  Could not tell whether a gateway is running.");
    console.log("  Restart a running one with `openclaw gateway restart` so it");
    console.log("  picks up this config, or start one with `openclaw gateway run`.");
    return false;
  }

  if (running) {
    console.log("  Detected a running OpenClaw gateway.");
    console.log("  It is still on the old config - Inkbox only takes effect");
    console.log("  once the gateway restarts.");
    if (!(await prompter.confirm("Restart the gateway now?", true))) {
      console.log("  Skipped. Run `openclaw gateway restart` before using Inkbox.");
      return true;
    }
    console.log("  Restarting...");
    if (runLifecycle(run, "restart")) {
      console.log("  Gateway restarted with the new Inkbox config.");
    } else {
      console.log("  Restart it manually: openclaw gateway restart");
    }
    return true;
  }

  console.log("  Did not detect a running OpenClaw gateway - Inkbox is");
  console.log("  configured, but nothing is listening for it yet.");

  if (serviceInstalled) {
    if (!(await prompter.confirm("Launch the gateway now?", true))) {
      console.log("  Skipped. Run `openclaw gateway start` when you're ready.");
      return false;
    }
    console.log("  Starting...");
    if (!runLifecycle(run, "start")) {
      console.log("  Start it manually: openclaw gateway start");
      return false;
    }
    // Exit 0 only means the command ran. A gateway that fails to bind is gone
    // a second or two later, so confirm rather than take its word for it.
    if (await waitForGatewayRunning(run, confirmTimeoutMs, opts.sleep)) {
      console.log("  Gateway started with the new Inkbox config.");
      return true;
    }
    console.log("  Gateway start completed.");
    console.log(
      `  Could not confirm the gateway came up within ${Math.round(confirmTimeoutMs / 1000)}s.`,
    );
    console.log("  Check it with: openclaw gateway status");
    return true;
  }

  // No service slot yet: `install` registers one with launchd/systemd/schtasks
  // and brings it up, so it covers install-and-launch in a single step.
  console.log("  Installing the gateway service keeps it running across reboots.");
  if (!(await prompter.confirm("Install and launch the gateway service now?", true))) {
    console.log("  Skipped. Run `openclaw gateway install`, or `openclaw gateway run`");
    console.log("  to start one in the foreground.");
    return false;
  }
  console.log("  Installing...");
  if (!runLifecycle(run, "install")) {
    console.log("  Start one in the foreground instead: openclaw gateway run");
    return false;
  }

  // `install` brings the gateway up in whatever way the platform allows - a
  // service slot, or a plain background process when the service manager
  // refuses the bootstrap. Either way it needs a moment to become visible.
  if (await waitForGatewayRunning(run, confirmTimeoutMs, opts.sleep)) {
    console.log("  Gateway installed and running with the new Inkbox config.");
    return true;
  }

  // Install reported success, so never answer it with "now go start one":
  // if it did bring a gateway up, a second start would duplicate it.
  console.log("  Gateway install completed.");
  console.log(
    `  Could not confirm the gateway came up within ${Math.round(confirmTimeoutMs / 1000)}s.`,
  );
  console.log("  Check it with: openclaw gateway status");
  return true;
}

/**
 * Print the closing banner for a setup that ended with a live gateway.
 *
 * @param handle - Inkbox agent identity the gateway is now running as.
 * @param product - Host name shown in the headline.
 * @param doctorCommand - Command that checks the connection.
 */
export function printReadyBanner(
  handle: string,
  product = "OpenClaw",
  doctorCommand = "openclaw inkbox doctor",
): void {
  const rows: Array<[string, string]> = [
    ["Inkbox identity", handle],
    ["Check its health", doctorCommand],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 1; // +1 for the colon
  const body = [
    `Your ${product} agent is set up and running on Inkbox.`,
    "",
    ...rows.map(([label, value]) => `  ${`${label}:`.padEnd(labelWidth)}  ${value}`),
  ];
  const width = Math.max(...body.map((line) => line.length)) + 4;
  console.log("");
  console.log(`╭${"─".repeat(width - 2)}╮`);
  for (const line of body) console.log(`│ ${line.padEnd(width - 4)} │`);
  console.log(`╰${"─".repeat(width - 2)}╯`);
}
