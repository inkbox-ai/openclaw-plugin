import { Inkbox } from "@inkbox/sdk";
import { readIdentityState } from "./state.js";

// CLI registrar — called by OpenClaw with a commander-style `program` so we
// can attach the `inkbox` subcommand group. Each action is self-contained
// and reads its config from env vars (INKBOX_API_KEY, INKBOX_IDENTITY,
// INKBOX_BASE_URL) so the commands work regardless of how OpenClaw threads
// plugin config into the CLI process.
export function registerInkboxCli(program: any): void {
  const inkbox = program
    .command("inkbox")
    .description("Inkbox plugin commands (setup, doctor, whoami)");

  inkbox
    .command("doctor")
    .description("Diagnose the Inkbox plugin's configuration and connection state")
    .action(async () => {
      await runDoctor();
    });

  inkbox
    .command("whoami")
    .description("Print the authenticated Inkbox identity and key info")
    .action(async () => {
      await runWhoami();
    });

  inkbox
    .command("setup")
    .description("Interactive setup for the Inkbox plugin (identity, phone, signing key)")
    .action(async () => {
      // Lazy import so the readline prompter isn't pulled into doctor/whoami
      // command paths that don't need it.
      const { runSetupWizardCli } = await import("./setup-wizard.js");
      await runSetupWizardCli();
    });
}

interface CliConfig {
  apiKey: string | undefined;
  identity: string | undefined;
  baseUrl: string | undefined;
  signingKey: string | undefined;
}

function readEnvConfig(): CliConfig {
  return {
    apiKey: process.env.INKBOX_API_KEY,
    identity: process.env.INKBOX_IDENTITY,
    baseUrl: process.env.INKBOX_BASE_URL,
    signingKey: process.env.INKBOX_SIGNING_KEY,
  };
}

function fmt(label: string, value: string | null | undefined, masked = false): string {
  if (value === undefined || value === null || value === "") return `  ${label}: (not set)`;
  const display = masked ? `${value.slice(0, 8)}…` : value;
  return `  ${label}: ${display}`;
}

async function runDoctor(): Promise<void> {
  const cfg = readEnvConfig();
  console.log("Inkbox plugin doctor\n");

  // Section 1: config presence.
  console.log("Config (from env vars):");
  console.log(fmt("INKBOX_API_KEY", cfg.apiKey, true));
  console.log(fmt("INKBOX_IDENTITY", cfg.identity));
  console.log(fmt("INKBOX_BASE_URL", cfg.baseUrl ?? "(default: https://inkbox.ai)"));
  console.log(fmt("INKBOX_SIGNING_KEY", cfg.signingKey, true));
  console.log();

  if (!cfg.apiKey || !cfg.identity) {
    console.log(
      "❌ Missing required config. Set INKBOX_API_KEY and INKBOX_IDENTITY (or configure via plugins.entries.inkbox.config) and re-run.",
    );
    process.exitCode = 1;
    return;
  }

  // Section 2: live API check.
  console.log("Live API check:");
  try {
    const client = new Inkbox({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    const info = await client.whoami();
    console.log(`  authType: ${info.authType}`);
    if (info.authType === "api_key") {
      console.log(`  authSubtype: ${info.authSubtype}`);
      console.log(`  keyLabel: ${info.label ?? "(unlabeled)"}`);
    }
    console.log(`  organizationId: ${info.organizationId}`);
    console.log();

    const identity = await client.getIdentity(cfg.identity);
    console.log("Identity:");
    console.log(`  handle: ${identity.handle}`);
    console.log(`  emailAddress: ${identity.mailbox?.emailAddress ?? "(no mailbox)"}`);
    console.log(`  phoneNumber: ${identity.phoneNumber?.number ?? "(no phone)"}`);
    if (identity.phoneNumber) {
      console.log(`  smsStatus: ${identity.phoneNumber.smsStatus}`);
    }
    console.log();

    console.log("✅ Inkbox connection healthy.");

    // Section 3: cached state (from `openclaw inkbox setup`).
    const cached = await readIdentityState();
    if (cached) {
      console.log("\nCached state (~/.openclaw/inkbox/identity-state.json):");
      console.log(`  identityHandle: ${cached.identityHandle}`);
      console.log(`  emailAddress: ${cached.emailAddress ?? "(none)"}`);
      console.log(`  phoneNumber: ${cached.phoneNumber ?? "(none)"}`);
      console.log(`  tunnelPublicHost: ${cached.tunnelPublicHost ?? "(none)"}`);
      console.log(`  savedAt: ${cached.savedAt}`);
      if (cached.identityHandle !== cfg.identity) {
        console.log(
          `\n⚠️  Cached identity (${cached.identityHandle}) does not match INKBOX_IDENTITY (${cfg.identity}). Re-run setup to refresh.`,
        );
      }
    } else {
      console.log("\nNo cached state — run `openclaw inkbox setup` to generate one.");
    }
  } catch (err) {
    console.log(`❌ API check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runWhoami(): Promise<void> {
  const cfg = readEnvConfig();
  if (!cfg.apiKey) {
    console.log("INKBOX_API_KEY not set.");
    process.exitCode = 1;
    return;
  }
  try {
    const client = new Inkbox({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    const info = await client.whoami();
    // Single-line summary — handy for shell scripting.
    if (info.authType === "api_key") {
      console.log(`api_key ${info.authSubtype} org=${info.organizationId} label=${info.label ?? "-"}`);
    } else {
      console.log(`jwt org=${info.organizationId}`);
    }
  } catch (err) {
    console.log(`whoami failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

