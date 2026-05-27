import { Inkbox, InkboxAPIError } from "@inkbox/sdk";
import {
  registerHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
  type HealthRepairContext,
  type HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { resolveInkboxAccount } from "./accounts.js";
import { readIdentityState, writeIdentityState } from "./state.js";

const SOURCE = "@inkbox/openclaw-plugin";

const CHECKS = [
  "inkbox/config-missing-api-key",
  "inkbox/config-missing-identity",
  "inkbox/config-missing-signing-key",
  "inkbox/auth-whoami-failed",
  "inkbox/auth-key-admin-scoped",
  "inkbox/identity-not-found",
  "inkbox/cached-state-missing",
  "inkbox/cached-state-stale",
  "inkbox/no-mailbox",
  "inkbox/no-phone-number",
  "inkbox/sms-not-ready",
  "inkbox/tunnel-config-conflict",
] as const;

type InkboxCheckId = (typeof CHECKS)[number];

const DESCRIPTIONS: Record<InkboxCheckId, string> = {
  "inkbox/config-missing-api-key": "Inkbox API key is configured",
  "inkbox/config-missing-identity": "Inkbox identity handle is configured",
  "inkbox/config-missing-signing-key": "Inkbox webhook signing key is configured",
  "inkbox/auth-whoami-failed": "Inkbox API key authenticates successfully",
  "inkbox/auth-key-admin-scoped": "Inkbox API key is agent-scoped",
  "inkbox/identity-not-found": "Configured Inkbox identity exists",
  "inkbox/cached-state-missing": "Inkbox cached identity state exists",
  "inkbox/cached-state-stale": "Inkbox cached identity state matches config",
  "inkbox/no-mailbox": "Inkbox identity has a mailbox",
  "inkbox/no-phone-number": "Inkbox identity has a phone number",
  "inkbox/sms-not-ready": "Inkbox identity phone number can send SMS",
  "inkbox/tunnel-config-conflict": "Inkbox public URL and tunnel config are not conflicting",
};

const OC_BASE = "oc://config/channels/inkbox";

function finding(
  checkId: InkboxCheckId,
  severity: HealthFinding["severity"],
  message: string,
  path: string,
  fixHint: string,
): HealthFinding {
  const configPath = path.startsWith("channels.inkbox.")
    ? `${OC_BASE}/${path.replace("channels.inkbox.", "").replaceAll(".", "/")}`
    : path === "channels.inkbox"
      ? OC_BASE
      : undefined;
  return {
    checkId,
    severity,
    message,
    source: SOURCE,
    path,
    ocPath: configPath,
    fixHint,
  };
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof InkboxAPIError && error.statusCode === 404;
}

export async function detectInkboxHealthFindings(
  ctx: Pick<HealthCheckContext, "cfg">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const account = resolveInkboxAccount({ cfg: ctx.cfg, env });

  if (!account.apiKey) {
    findings.push(
      finding(
        "inkbox/config-missing-api-key",
        "error",
        "Inkbox apiKey is missing.",
        "channels.inkbox.apiKey",
        "Run `openclaw inkbox setup` or set channels.inkbox.apiKey / INKBOX_API_KEY.",
      ),
    );
  } else if (!account.apiKey.startsWith("ApiKey_")) {
    findings.push(
      finding(
        "inkbox/config-missing-api-key",
        "error",
        "Inkbox apiKey is present but does not look like an ApiKey_ value.",
        "channels.inkbox.apiKey",
        "Use an Inkbox API key that starts with ApiKey_.",
      ),
    );
  }

  if (!account.identity) {
    findings.push(
      finding(
        "inkbox/config-missing-identity",
        "error",
        "Inkbox identity handle is missing.",
        "channels.inkbox.identity",
        "Run `openclaw inkbox setup` or set channels.inkbox.identity / INKBOX_IDENTITY.",
      ),
    );
  }

  if (!account.signingKey) {
    findings.push(
      finding(
        "inkbox/config-missing-signing-key",
        "warning",
        "Inkbox signingKey is missing, so inbound email/SMS/call webhooks cannot be verified.",
        "channels.inkbox.signingKey",
        "Run `openclaw inkbox setup` to paste or rotate a webhook signing key.",
      ),
    );
  }

  if (account.publicUrl && account.tunnelName) {
    findings.push(
      finding(
        "inkbox/tunnel-config-conflict",
        "warning",
        "Both publicUrl and tunnelName are set; publicUrl takes precedence and the tunnel name is ignored.",
        "channels.inkbox",
        "Remove either publicUrl or tunnelName so the intended inbound route is unambiguous.",
      ),
    );
  }

  if (!account.apiKey || !account.identity || !account.apiKey.startsWith("ApiKey_")) {
    return findings;
  }

  const client = new Inkbox({ apiKey: account.apiKey, baseUrl: account.baseUrl });

  try {
    const info = await client.whoami();
    if (info.authType === "api_key" && info.authSubtype === "api_key.admin_scoped") {
      findings.push(
        finding(
          "inkbox/auth-key-admin-scoped",
          "warning",
          "Inkbox is using an admin-scoped API key; the plugin is designed to run with an agent-scoped key.",
          "channels.inkbox.apiKey",
          "Run `openclaw inkbox setup` with the admin key to mint an agent-scoped key for this identity.",
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        "inkbox/auth-whoami-failed",
        "error",
        `Inkbox whoami failed: ${messageFromError(error)}`,
        "channels.inkbox.apiKey",
        "Verify the API key, baseUrl, and network connectivity.",
      ),
    );
    return findings;
  }

  let identity;
  try {
    identity = await client.getIdentity(account.identity);
  } catch (error) {
    findings.push(
      finding(
        "inkbox/identity-not-found",
        "error",
        isNotFound(error)
          ? `Inkbox identity ${account.identity} was not found for this API key.`
          : `Inkbox identity lookup failed for ${account.identity}: ${messageFromError(error)}`,
        "channels.inkbox.identity",
        "Set identity to a handle visible to this API key, or mint a key scoped to the configured identity.",
      ),
    );
    return findings;
  }

  const cached = await readIdentityState();
  if (!cached) {
    findings.push(
      finding(
        "inkbox/cached-state-missing",
        "info",
        "Inkbox cached identity state is missing.",
        "~/.openclaw/inkbox/identity-state.json",
        "Run `openclaw inkbox setup` or `openclaw doctor --fix --only inkbox/cached-state-missing` to refresh local state.",
      ),
    );
  } else if (
    cached.identityHandle !== account.identity ||
    cached.emailAddress !== (identity.mailbox?.emailAddress ?? null) ||
    cached.phoneNumber !== (identity.phoneNumber?.number ?? null) ||
    cached.tunnelPublicHost !== (identity.tunnel?.publicHost ?? null)
  ) {
    findings.push(
      finding(
        "inkbox/cached-state-stale",
        "info",
        "Inkbox cached identity state does not match the live configured identity.",
        "~/.openclaw/inkbox/identity-state.json",
        "Run `openclaw inkbox setup` or `openclaw doctor --fix --only inkbox/cached-state-stale` to refresh local state.",
      ),
    );
  }

  if (!identity.mailbox) {
    findings.push(
      finding(
        "inkbox/no-mailbox",
        "warning",
        `Inkbox identity ${account.identity} has no mailbox; email tools will not work.`,
        "channels.inkbox.identity",
        "Create or repair the identity in Inkbox so it has a mailbox.",
      ),
    );
  }

  if (!identity.phoneNumber) {
    findings.push(
      finding(
        "inkbox/no-phone-number",
        "info",
        `Inkbox identity ${account.identity} has no phone number; SMS and call tools are unavailable.`,
        "channels.inkbox.identity",
        "Run `openclaw inkbox setup` and choose phone provisioning, or provision a number in Inkbox.",
      ),
    );
  } else if (String(identity.phoneNumber.smsStatus).toLowerCase() !== "ready") {
    findings.push(
      finding(
        "inkbox/sms-not-ready",
        "warning",
        `Inkbox phone ${identity.phoneNumber.number} has smsStatus=${identity.phoneNumber.smsStatus}.`,
        "channels.inkbox.identity",
        "Wait for carrier propagation or have the recipient text START before retrying outbound SMS.",
      ),
    );
  }

  return findings;
}

async function repairCachedState(
  ctx: HealthRepairContext,
): Promise<HealthRepairResult> {
  const account = resolveInkboxAccount({ cfg: ctx.cfg, env: process.env });
  if (!account.apiKey || !account.identity) {
    return {
      status: "skipped",
      reason: "Inkbox apiKey and identity are required before cached state can be refreshed.",
      changes: [],
    };
  }
  const client = new Inkbox({ apiKey: account.apiKey, baseUrl: account.baseUrl });
  const identity = await client.getIdentity(account.identity);
  await writeIdentityState({
    identityHandle: account.identity,
    emailAddress: identity.mailbox?.emailAddress ?? null,
    phoneNumber: identity.phoneNumber?.number ?? null,
    tunnelPublicHost: identity.tunnel?.publicHost ?? null,
    savedAt: new Date().toISOString(),
  });
  return {
    changes: ["Refreshed ~/.openclaw/inkbox/identity-state.json from the live Inkbox identity."],
    effects: [
      {
        kind: "state",
        action: "write",
        target: "~/.openclaw/inkbox/identity-state.json",
        dryRunSafe: false,
      },
    ],
  };
}

const cache = new WeakMap<object, Promise<readonly HealthFinding[]>>();
let registered = false;

async function detectCached(ctx: HealthCheckContext): Promise<readonly HealthFinding[]> {
  let promise = cache.get(ctx);
  if (!promise) {
    promise = detectInkboxHealthFindings(ctx);
    cache.set(ctx, promise);
  }
  return promise;
}

function makeHealthCheck(id: InkboxCheckId): HealthCheck {
  return {
    id,
    kind: "plugin",
    source: SOURCE,
    description: DESCRIPTIONS[id],
    async detect(ctx) {
      const findings = await detectCached(ctx);
      return findings.filter((finding) => finding.checkId === id);
    },
    ...(id === "inkbox/cached-state-missing" || id === "inkbox/cached-state-stale"
      ? { repair: repairCachedState }
      : {}),
  };
}

export function registerInkboxHealthChecks(): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const id of CHECKS) {
    registerHealthCheck(makeHealthCheck(id));
  }
}
