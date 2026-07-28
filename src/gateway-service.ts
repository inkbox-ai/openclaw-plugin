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
 * Offer to restart (or start, or install) the gateway so the config this
 * wizard just wrote actually takes effect.
 *
 * @param prompter - Prompter used for the yes/no questions.
 * @param run - Host-CLI runner; injectable so tests never spawn a process.
 * @returns True when a gateway is running by the time this returns.
 */
export async function offerGatewayRestart(
  prompter: Prompter,
  run: GatewayCommandRunner = defaultGatewayCommandRunner,
): Promise<boolean> {
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
    if (runLifecycle(run, "start")) {
      console.log("  Gateway started with the new Inkbox config.");
      return true;
    }
    console.log("  Start it manually: openclaw gateway start");
    return false;
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

  // `install` does not guarantee the service came up, so re-check rather
  // than assuming it did.
  if (detectGatewayState(run).running) {
    console.log("  Gateway installed and running with the new Inkbox config.");
    return true;
  }
  console.log("  Gateway service installed.");
  console.log("  Start it with: openclaw gateway start");
  return false;
}
