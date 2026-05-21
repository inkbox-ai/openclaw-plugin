import {
  Inkbox,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
  AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED,
} from "@inkbox/sdk";
import type { Prompter } from "./prompt.js";
import { writeIdentityState, readIdentityState } from "./state.js";

export interface WizardOptions {
  prompter: Prompter;
  // Lets tests inject env without poking process.env.
  env?: NodeJS.ProcessEnv;
}

export interface WizardResult {
  ok: boolean;
  message?: string;
  // Final values to drop into plugins.entries.inkbox.config — printed at the
  // end so the user can copy/paste.
  config?: {
    apiKey: string;
    identity: string;
    signingKey?: string;
  };
}

// Three-branch wizard:
//   A. No apiKey yet  → direct to web signup (self-signup SDK flow lands later)
//   B. apiKey + admin → pick an existing identity or create one, then mint
//                       an agent-scoped key bound to it; rest of flow runs on
//                       the agent-scoped key
//   C. apiKey + agent → confirm identity, offer phone provision if missing,
//                       (re)generate signing key, persist state
export async function runSetupWizard(opts: WizardOptions): Promise<WizardResult> {
  const env = opts.env ?? process.env;
  const prompter = opts.prompter;

  console.log("Inkbox plugin setup\n");

  // Step 1 — read or prompt for API key.
  let apiKey = env.INKBOX_API_KEY?.trim();
  if (!apiKey) {
    console.log("No INKBOX_API_KEY in env.");
    const hasAccount = await prompter.confirm("Do you have an Inkbox account?", true);
    if (!hasAccount) {
      console.log(
        "\nThe in-CLI signup flow isn't wired yet. For now, please:\n" +
          "  1. Open https://inkbox.ai/console\n" +
          "  2. Sign up (email-verified, ~1 min).\n" +
          "  3. Mint an agent-scoped API key.\n" +
          "  4. Re-run `openclaw inkbox setup` with INKBOX_API_KEY set.\n",
      );
      return { ok: false, message: "self-signup not yet implemented in CLI" };
    }
    apiKey = await prompter.ask("Paste your Inkbox API key (starts with ApiKey_)");
    if (!apiKey || !apiKey.startsWith("ApiKey_")) {
      return { ok: false, message: "Invalid API key format. Expected an ApiKey_... string." };
    }
  }

  const baseUrl = env.INKBOX_BASE_URL;
  const client = new Inkbox({ apiKey, baseUrl });

  // Step 2 — whoami to discover scope.
  let info;
  try {
    info = await client.whoami();
  } catch (err) {
    return {
      ok: false,
      message: `whoami failed: ${err instanceof Error ? err.message : String(err)}. Is the API key correct?`,
    };
  }
  if (info.authType !== "api_key") {
    return {
      ok: false,
      message: `Unsupported auth type for the wizard: ${info.authType}. Use an API key.`,
    };
  }
  const subtype = info.authSubtype;
  console.log(`Authenticated. org=${info.organizationId} subtype=${subtype}\n`);

  // Step 3 — branch on subtype.
  let identityHandle: string;
  let agentApiKey: string = apiKey;

  if (subtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED) {
    // Branch B — admin scoped.
    console.log("Admin-scoped key detected. The wizard will create or select an identity, then mint an agent-scoped key for the plugin to use.\n");
    const identities = await client.listIdentities();
    if (identities.length > 0) {
      console.log("Existing identities:");
      identities.forEach((i, idx) => console.log(`  ${idx + 1}. ${i.handle}`));
      console.log("  N. Create a new identity");
      const pick = await prompter.ask("Pick (1..N)", "N");
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= identities.length) {
        identityHandle = identities[idx - 1].handle;
      } else {
        identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
        await client.createIdentity(identityHandle);
        console.log(`Created identity ${identityHandle}.`);
      }
    } else {
      identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
      await client.createIdentity(identityHandle);
      console.log(`Created identity ${identityHandle}.`);
    }
    // Mint an agent-scoped key bound to this identity. The plugin should use
    // this going forward, not the admin key the user pasted.
    const identityRecord = await client.getIdentity(identityHandle);
    const newKey = await (client as any).apiKeys.create({
      scopedIdentityId: identityRecord.id,
      label: `openclaw-plugin-${identityHandle}`,
    });
    agentApiKey = newKey.apiKey ?? newKey.api_key;
    console.log(`Minted agent-scoped key: ${agentApiKey.slice(0, 12)}…  (save this — it won't be shown again).\n`);
  } else if (
    subtype === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED ||
    subtype === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED
  ) {
    // Branch C — agent scoped (preferred).
    const fromEnv = env.INKBOX_IDENTITY?.trim();
    if (fromEnv) {
      identityHandle = fromEnv;
    } else {
      identityHandle = await prompter.ask(
        "Identity handle this key is bound to (lowercase, 3-63 chars)",
      );
    }
  } else {
    return {
      ok: false,
      message: `Unsupported auth subtype: ${subtype}. Mint an agent-scoped or admin-scoped key.`,
    };
  }

  // Re-construct a client with the (possibly new) agent-scoped key so the
  // identity resolves under the right access.
  const agentClient = subtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED
    ? new Inkbox({ apiKey: agentApiKey, baseUrl })
    : client;
  const identity = await agentClient.getIdentity(identityHandle);

  // Step 4 — optional phone provision.
  if (!identity.phoneNumber) {
    const wantPhone = await prompter.confirm(
      "This identity has no phone number. Provision a local number for SMS + voice now?",
      true,
    );
    if (wantPhone) {
      const phone = await identity.provisionPhoneNumber({ type: "local" });
      console.log(
        `Provisioned ${phone.number}. SMS will be ready in ~10–15 min once 10DLC carrier propagation completes.`,
      );
    }
  }

  // Step 5 — signing key for inbound webhooks.
  const wantSigningKey = await prompter.confirm(
    "Generate a webhook signing key now? (Required to receive inbound email/SMS/calls.)",
    true,
  );
  let signingKey: string | undefined;
  if (wantSigningKey) {
    const sk = await agentClient.createSigningKey();
    signingKey = (sk as any).signingKey ?? (sk as any).key;
    if (!signingKey) {
      console.log("⚠️  Signing key call succeeded but the response shape was unexpected — fall back to creating one in the Console.");
    } else {
      console.log(`Signing key: ${signingKey.slice(0, 14)}…  (save this — it won't be shown again).\n`);
    }
  }

  // Step 6 — persist non-secret state for future doctor/CLI runs.
  await writeIdentityState({
    identityHandle,
    emailAddress: identity.mailbox?.emailAddress ?? null,
    phoneNumber: identity.phoneNumber?.number ?? null,
    tunnelPublicHost: identity.tunnel?.publicHost ?? null,
    savedAt: new Date().toISOString(),
  });

  // Step 7 — print the config snippet.
  const snippet = {
    apiKey: agentApiKey,
    identity: identityHandle,
    ...(signingKey ? { signingKey } : {}),
  };
  console.log(
    "\n✅ Setup complete. Add this to your OpenClaw config under plugins.entries.inkbox.config:\n",
  );
  console.log(JSON.stringify(snippet, null, 2));
  console.log(
    "\nThen run `openclaw inkbox doctor` to verify the connection.\n",
  );

  return { ok: true, config: snippet };
}

// Light wrapper used by the CLI command — instantiates a readline prompter,
// runs the wizard, and ensures the prompter is closed even on error.
export async function runSetupWizardCli(): Promise<void> {
  const { createReadlinePrompter } = await import("./prompt.js");
  const prompter = createReadlinePrompter();
  try {
    const result = await runSetupWizard({ prompter });
    if (!result.ok) {
      console.error(`\n❌ Setup did not complete: ${result.message}`);
      process.exitCode = 1;
    }
  } finally {
    await prompter.close();
  }
}

// Re-export readIdentityState for convenience (doctor and other CLI commands
// will want it).
export { readIdentityState };
