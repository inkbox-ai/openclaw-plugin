import { Inkbox } from "@inkbox/sdk";

// CLI registrar — called by OpenClaw with a commander-style `program` so we
// can attach the `inkbox` subcommand group. Each action is self-contained
// and reads its config from env vars (INKBOX_API_KEY, INKBOX_IDENTITY,
// INKBOX_BASE_URL) so the commands work regardless of how OpenClaw threads
// plugin config into the CLI process. The full setup wizard (interactive
// signup → identity → key mint → persist) is stubbed here; it lands in a
// follow-up commit.
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
    .description("Interactive setup for the Inkbox plugin (signup, identity, key, signing key)")
    .action(async () => {
      printSetupStub();
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

function printSetupStub(): void {
  console.log(`Inkbox plugin setup (interactive wizard coming soon).

For now, configure manually:

1. Sign up at https://inkbox.ai/console (or sign in to an existing account).
2. Create an agent identity. This atomically provisions a mailbox at
   <handle>@inkboxmail.com and a tunnel.
3. Provision a phone number on the identity if you want SMS or voice.
   Local numbers support SMS; toll-free numbers are voice-only today.
4. Mint an agent-scoped API key bound to that identity.
5. (Optional, for inbound) Generate a webhook signing key in the Console.
6. Drop the values into OpenClaw config at plugins.entries.inkbox.config:

   {
     "apiKey": "ApiKey_xxxxxxxxxxxx",
     "identity": "your-agent-handle",
     "signingKey": "whsec_xxxxxxxxxxxx"
   }

7. Verify with: openclaw inkbox doctor
`);
}
