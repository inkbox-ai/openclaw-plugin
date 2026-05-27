import {
  InkboxAPIError,
  Inkbox,
  type AgentIdentity,
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

const SMS_OPT_IN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const SMS_OPT_IN_POLL_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStartText(text: string | null | undefined): boolean {
  return text?.trim().toUpperCase() === "START";
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function summarizeIdentity(identity: {
  agentHandle: string;
  displayName?: string | null;
  emailAddress?: string | null;
  mailbox?: { emailAddress?: string | null } | null;
  phoneNumber?: { number?: string | null; type?: string | null; smsStatus?: string | null } | null;
}): string {
  const parts = [identity.agentHandle];
  if (identity.displayName) parts.push(`display=${identity.displayName}`);
  const email = identity.mailbox?.emailAddress ?? identity.emailAddress;
  if (email) parts.push(`email=${email}`);
  if (identity.phoneNumber?.number) {
    const smsStatus = identity.phoneNumber.smsStatus ? ` sms=${identity.phoneNumber.smsStatus}` : "";
    parts.push(`phone=${identity.phoneNumber.number}${smsStatus}`);
  }
  return parts.join("  ");
}

function messageFromError(error: unknown): string {
  if (error instanceof InkboxAPIError) {
    const detail =
      typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail ?? {});
    return `HTTP ${error.statusCode} ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function printInkboxAuthorizationInfo(): void {
  console.log("\nInkbox authorization lives server-side via contact rules:");
  console.log("  https://console.inkbox.ai -> Mailboxes / Phone Numbers -> Contact Rules");
  console.log(
    "Anyone Inkbox lets through reaches the agent; this wizard does not create a second local inbound allowlist.",
  );
}

function printAgentSummary(identity: AgentIdentity): void {
  console.log("\nInkbox configured\n");
  console.log(`  Handle:  ${identity.agentHandle}`);
  const email = identity.mailbox?.emailAddress ?? identity.emailAddress;
  console.log(`  Mailbox: ${email ?? "(none - set up later in the Inkbox console)"}`);
  if (identity.phoneNumber) {
    const smsStatus = identity.phoneNumber.smsStatus ? `; SMS: ${identity.phoneNumber.smsStatus}` : "";
    console.log(`  Phone:   ${identity.phoneNumber.number} (${identity.phoneNumber.type}${smsStatus})`);
    if (identity.phoneNumber.type === "local") {
      console.log("\nSMS opt-in:");
      console.log(`  Text START to ${identity.phoneNumber.number} from each phone this agent should text.`);
    }
  } else {
    console.log("  Phone:   (none - provision later in the Inkbox console)");
  }
  console.log("\nReachability rules:");
  console.log("  Manage who can reach this agent at https://inkbox.ai/console/contact-rules");
  console.log("  Use mailbox and phone contact rules for email senders, domains, and phone numbers.");
}

async function maybeProvisionPhoneNumber(
  identity: AgentIdentity,
  prompter: Prompter,
): Promise<{ identity: AgentIdentity; didProvisionPhone: boolean }> {
  if (identity.phoneNumber) {
    return { identity, didProvisionPhone: false };
  }
  const wantPhone = await prompter.confirm(
    "This identity has no phone number. Provision a local number for SMS + voice now?",
    true,
  );
  if (!wantPhone) {
    return { identity, didProvisionPhone: false };
  }
  const state = normalizeOptional(
    await prompter.ask("US state for the local number (optional, e.g. NY)"),
  );
  try {
    const phone = await identity.provisionPhoneNumber({
      type: "local",
      ...(state ? { state } : {}),
    });
    console.log(
      `Provisioned ${phone.number}. SMS will be ready in ~10-15 min once 10DLC carrier propagation completes.`,
    );
    return { identity: await identity.refresh(), didProvisionPhone: true };
  } catch (error) {
    console.log(`Phone provisioning failed: ${messageFromError(error)}`);
    console.log("You can provision a number later in the Inkbox console.");
    return { identity, didProvisionPhone: false };
  }
}

async function discoverAgentIdentityHandle(
  client: Inkbox,
  env: NodeJS.ProcessEnv,
  prompter: Prompter,
): Promise<string> {
  const fromEnv = env.INKBOX_IDENTITY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const identities = await client.listIdentities();
    if (identities.length === 1) {
      return identities[0].agentHandle;
    }
    if (identities.length > 1) {
      console.log("This key can see multiple identities:");
      identities.forEach((i, idx) => console.log(`  ${idx + 1}. ${i.agentHandle}`));
      const pick = await prompter.ask("Pick identity (1..N)", "1");
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= identities.length) {
        return identities[idx - 1].agentHandle;
      }
    }
  } catch {
    // Some key states may not allow listIdentities; fall back to prompt.
  }
  return prompter.ask("Identity handle this key is bound to (lowercase, 3-63 chars)");
}

async function waitForSmsStart(params: {
  identity: AgentIdentity;
  ownerNumber?: string;
}): Promise<void> {
  if (params.identity.phoneNumber?.type !== "local") {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < SMS_OPT_IN_WAIT_TIMEOUT_MS) {
    const texts = await params.identity.listTexts({ limit: 25 });
    const found = texts.some((text) => {
      if (text.direction !== "inbound" || !isStartText(text.text)) {
        return false;
      }
      return !params.ownerNumber || text.remotePhoneNumber === params.ownerNumber;
    });
    if (found) {
      console.log("Received START opt-in text.");
      return;
    }
    await sleep(SMS_OPT_IN_POLL_MS);
  }
  console.log(
    "Did not observe START before the wait timed out. SMS may still fail with recipient_not_opted_in until the recipient texts START to the Inkbox number.",
  );
}

async function runSelfSignup(params: {
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
}): Promise<{ apiKey: string; identityHandle: string }> {
  const humanEmail = await params.prompter.ask("Your email address for Inkbox verification");
  const agentHandle = normalizeOptional(
    await params.prompter.ask("Requested agent handle (optional)"),
  );
  const displayName = normalizeOptional(
    await params.prompter.ask("Agent display name (optional)"),
  );
  const noteToHuman =
    normalizeOptional(
      await params.prompter.ask(
        "Verification email note",
        "OpenClaw Inkbox plugin setup",
      ),
    ) ?? "OpenClaw Inkbox plugin setup";
  try {
    const signup = await Inkbox.signup(
      {
        humanEmail,
        noteToHuman,
        ...(agentHandle ? { agentHandle } : {}),
        ...(displayName ? { displayName } : {}),
      },
      { baseUrl: params.env.INKBOX_BASE_URL },
    );
    console.log(`Created Inkbox agent ${signup.agentHandle} (${signup.emailAddress}).`);
    console.log(signup.message);
    const code = normalizeOptional(
      await params.prompter.ask("Verification code from email (leave blank to verify later)"),
    );
    if (code) {
      await Inkbox.verifySignup(
        signup.apiKey,
        { verificationCode: code },
        { baseUrl: params.env.INKBOX_BASE_URL },
      );
      console.log("Signup verified.");
    } else {
      console.log("Signup is unverified. Verify from email before relying on unrestricted delivery.");
    }
    return { apiKey: signup.apiKey, identityHandle: signup.agentHandle };
  } catch (error) {
    if (error instanceof InkboxAPIError && (error.statusCode === 409 || error.statusCode === 422)) {
      throw new Error(
        `Self-signup failed (${error.statusCode}). The handle/email may be unavailable or invalid: ${typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)}`,
      );
    }
    throw error;
  }
}

// Three-branch wizard:
//   A. No apiKey yet  → self-signup or prompt for an existing key
//   B. apiKey + admin → pick an existing identity or create one, then mint
//                       an agent-scoped key bound to it; rest of flow runs on
//                       the agent-scoped key
//   C. apiKey + agent → confirm identity, offer phone provision if missing,
//                       (re)generate signing key, persist state
export async function runSetupWizard(opts: WizardOptions): Promise<WizardResult> {
  const env = opts.env ?? process.env;
  const prompter = opts.prompter;

  console.log("Inkbox plugin setup\n");

  const existingApiKey = env.INKBOX_API_KEY?.trim();
  const existingIdentity = env.INKBOX_IDENTITY?.trim();
  if (existingApiKey && existingIdentity) {
    const reconfigure = await prompter.confirm(
      `Inkbox is already configured for identity ${existingIdentity}. Reconfigure?`,
      false,
    );
    if (!reconfigure) {
      return {
        ok: true,
        message: "existing config kept",
        config: {
          apiKey: existingApiKey,
          identity: existingIdentity,
          ...(env.INKBOX_SIGNING_KEY ? { signingKey: env.INKBOX_SIGNING_KEY } : {}),
        },
      };
    }
  }

  // Step 1 — read or prompt for API key.
  let apiKey = existingApiKey;
  let signupIdentityHandle: string | undefined;
  if (!apiKey) {
    console.log("No INKBOX_API_KEY in env.");
    const hasAccount = await prompter.confirm("Do you have an Inkbox account?", true);
    if (!hasAccount) {
      const signup = await runSelfSignup({ env, prompter });
      apiKey = signup.apiKey;
      signupIdentityHandle = signup.identityHandle;
    } else {
      apiKey = await prompter.ask("Paste your Inkbox API key (starts with ApiKey_)");
    }
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
  let identity: AgentIdentity | undefined;
  let didProvisionPhone = false;

  if (subtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED) {
    // Branch B — admin scoped.
    console.log("Admin-scoped key detected. The wizard will create or select an identity, then mint an agent-scoped key for the plugin to use.\n");
    const identities = await client.listIdentities();
    const identityDetails: Array<AgentIdentity | undefined> = [];
    if (identities.length > 0) {
      console.log(`Found ${identities.length} identity(s). Fetching mailbox and phone details...`);
      for (const candidate of identities) {
        try {
          identityDetails.push(await client.getIdentity(candidate.agentHandle));
        } catch (error) {
          console.log(`  ${candidate.agentHandle}: details unavailable (${messageFromError(error)})`);
          identityDetails.push(undefined);
        }
      }
      console.log("Existing identities:");
      identities.forEach((i, idx) =>
        console.log(`  ${idx + 1}. ${summarizeIdentity(identityDetails[idx] ?? i)}`),
      );
      console.log("  N. Create a new identity");
      const pick = await prompter.ask("Pick (1..N)", "N");
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= identities.length) {
        identityHandle = identities[idx - 1].agentHandle;
        identity = identityDetails[idx - 1] ?? (await client.getIdentity(identityHandle));
      } else {
        identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
        const displayName = normalizeOptional(await prompter.ask("Display name (optional)"));
        const createPhone = await prompter.confirm(
          "Provision a local phone number for SMS + voice for this identity?",
          true,
        );
        identity = await client.createIdentity(identityHandle, {
          ...(displayName ? { displayName } : {}),
          ...(createPhone ? { phoneNumber: { type: "local", incomingCallAction: "auto_reject" } } : {}),
        });
        didProvisionPhone = createPhone && Boolean(identity.phoneNumber);
        console.log(`Created identity ${identityHandle}.`);
      }
    } else {
      identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
      const displayName = normalizeOptional(await prompter.ask("Display name (optional)"));
      const createPhone = await prompter.confirm(
        "Provision a local phone number for SMS + voice for this identity?",
        true,
      );
      identity = await client.createIdentity(identityHandle, {
        ...(displayName ? { displayName } : {}),
        ...(createPhone ? { phoneNumber: { type: "local", incomingCallAction: "auto_reject" } } : {}),
      });
      didProvisionPhone = createPhone && Boolean(identity.phoneNumber);
      console.log(`Created identity ${identityHandle}.`);
    }
    // Mint an agent-scoped key bound to this identity. The plugin should use
    // this going forward, not the admin key the user pasted.
    const identityRecord = identity ?? (await client.getIdentity(identityHandle));
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
    identityHandle =
      signupIdentityHandle ?? (await discoverAgentIdentityHandle(client, env, prompter));
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
  identity = await agentClient.getIdentity(identityHandle);

  // Step 4 — optional phone provision.
  if (!identity.phoneNumber) {
    const provisioned = await maybeProvisionPhoneNumber(identity, prompter);
    identity = provisioned.identity;
    didProvisionPhone = didProvisionPhone || provisioned.didProvisionPhone;
  }

  if (didProvisionPhone && identity.phoneNumber) {
    const ownerNumber = normalizeOptional(
      await prompter.ask(
        "Owner phone number to wait for START opt-in (optional E.164, e.g. +15551234567)",
      ),
    );
    const shouldWaitForStart = await prompter.confirm(
      "Wait up to 5 minutes for that recipient to text START to this Inkbox number?",
      Boolean(ownerNumber),
    );
    if (shouldWaitForStart) {
      await waitForSmsStart({ identity, ownerNumber });
    }
  }

  printInkboxAuthorizationInfo();

  // Step 5 — signing key for inbound webhooks.
  let signingKey = normalizeOptional(env.INKBOX_SIGNING_KEY ?? "");
  if (signingKey) {
    const keepExisting = await prompter.confirm("Use existing INKBOX_SIGNING_KEY?", true);
    if (!keepExisting) signingKey = undefined;
  }
  if (!signingKey) {
    const pasteExisting = await prompter.confirm(
      "Do you already have a webhook signing key to keep using?",
      false,
    );
    if (pasteExisting) {
      signingKey = normalizeOptional(await prompter.ask("Paste webhook signing key"));
    }
  }
  if (!signingKey) {
    const wantSigningKey = await prompter.confirm(
      "Generate/rotate the org webhook signing key now? This is required for inbound email/SMS/calls and replaces the previous org-level signing secret.",
      true,
    );
    if (wantSigningKey) {
      const sk = await agentClient.createSigningKey();
      signingKey = (sk as any).signingKey ?? (sk as any).key;
      if (!signingKey) {
        console.log("⚠️  Signing key call succeeded but the response shape was unexpected — fall back to creating one in the Console.");
      } else {
        console.log(`Signing key: ${signingKey.slice(0, 14)}…  (save this — it won't be shown again).\n`);
      }
    }
  }

  // Step 6 — persist non-secret state for future doctor/CLI runs.
  identity = await identity.refresh();
  await writeIdentityState({
    identityHandle,
    emailAddress: identity.mailbox?.emailAddress ?? null,
    phoneNumber: identity.phoneNumber?.number ?? null,
    tunnelPublicHost: identity.tunnel?.publicHost ?? null,
    savedAt: new Date().toISOString(),
  });
  printAgentSummary(identity);

  // Step 7 — print the channel config snippet.
  const snippet = {
    apiKey: agentApiKey,
    identity: identityHandle,
    ...(signingKey ? { signingKey } : {}),
  };
  console.log(
    "\n✅ Setup complete. Add this to your OpenClaw config under channels.inkbox:\n",
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
