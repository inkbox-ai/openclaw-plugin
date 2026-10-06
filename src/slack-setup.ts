import type { Inkbox, SlackConnectionsResponse, SlackProvisioningWorkspace } from "@inkbox/sdk";
import type { Prompter } from "./prompt.js";

export interface SlackSetupUI {
  prompter: Prompter;
  note(message: string): void;
  installation(url: string, expiresAt: Date): Promise<void> | void;
  signal?: AbortSignal;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  waitMs?: number;
}
const canceled = (ui: SlackSetupUI) => ui.signal?.aborted === true;
export async function configureSlack(client: Inkbox, identityId: string, previous: boolean, ui: SlackSetupUI): Promise<boolean> {
  const p = ui.prompter;
  if (!await p.confirm("Enable Slack messaging for this agent?", previous)) return false;
  const now = ui.now ?? Date.now;
  const delay = ui.delay ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); ui.signal?.removeEventListener("abort", done); resolve(); }
    ui.signal?.addEventListener("abort", done, { once: true });
  }));
  async function workspace(snapshot: SlackConnectionsResponse, renew = false): Promise<SlackProvisioningWorkspace | undefined> {
    const boundId = snapshot.provisioningWorkspace?.id ?? snapshot.setup?.provisioningWorkspaceId;
    if (snapshot.applicationCreated && !boundId) { ui.note("The app workspace is unavailable. Check Slack in the Inkbox Console."); return; }
    let selected = snapshot.provisioningWorkspace ?? undefined;
    if (!selected) {
      const choices = await client.slack.listProvisioningWorkspaces();
      if (boundId) {
        selected = choices.find((w) => w.id === boundId);
        if (!selected) { ui.note("The app's original workspace is unavailable."); return; }
      } else if (choices.length) {
        const value = p.select ? await p.select("Choose the workspace for this agent's Slack app", [...choices.map((w) => ({ value: w.id, label: `${w.workspaceName} (${w.workspaceId})` })), { value: "new", label: "Add a workspace" }], choices[0]!.id) : await p.ask("Workspace ID, or new to add one", choices[0]!.id);
        selected = choices.find((w) => w.id === value);
        if (!selected && value !== "new") { ui.note("No workspace selected."); return; }
      }
    }
    if (selected?.status === "ready" && !renew) return selected;
    if (!p.askSecret) { ui.note("Masked credential input is unavailable. Configure Slack in the Inkbox Console and rerun setup."); return; }
    ui.note("Open https://api.slack.com/apps and generate Your App Configuration Tokens for the selected workspace. Inkbox saves the pair; this plugin does not store it locally.");
    while (!canceled(ui)) {
      const accessToken = (await p.askSecret("App-configuration access token (blank to skip)")).trim();
      if (!accessToken) return;
      const refreshToken = (await p.askSecret("App-configuration refresh token (blank to skip)")).trim();
      if (!refreshToken) return;
      try {
        const saved = await client.slack.saveProvisioningWorkspace({ accessToken, refreshToken });
        if ((boundId && saved.id !== boundId) || (selected && saved.workspaceId !== selected.workspaceId)) { ui.note("These credentials belong to another workspace. The existing app cannot move."); }
        else if (saved.status === "ready") return saved;
        else ui.note("Workspace credentials need renewal.");
      } catch (error: any) {
        if (![400, 401, 403, 409, 422].includes(error?.statusCode)) { ui.note("Workspace credentials could not be saved; inspect setup before retrying."); return; }
        ui.note("The app-configuration credential pair was rejected. Check its type, workspace, and expiry.");
      }
      if (!await p.confirm("Enter a new credential pair?", false)) return;
    }
  }
  let verified = false;
  try {
    const who = await client.whoami();
    if (who.authType !== "api_key" || (who.authSubtype !== "api_key.admin_scoped" && (who.authSubtype !== "api_key.agent_scoped.claimed" || who.scope !== `agent_identity:${identityId}`))) { ui.note("Slack requires a claimed identity and its agent key or a supported administrative key."); return previous; }
    let snapshot = await client.slack.listConnections(identityId);
    verified = true;
    if (snapshot.connections.some((c) => c.identityId === identityId && c.status === "connected")) { ui.note("Slack is already connected for this identity."); return true; }
    if (!await p.confirm("Connect a Slack workspace now?", true)) return true;
    if (!snapshot.setup || snapshot.setup.status === "unavailable") { ui.note("Slack setup is unavailable. Check the Inkbox Console."); return true; }
    if (snapshot.setup.errorCode === "outcome_unknown") { ui.note("App creation has an unknown outcome. Check the existing setup before trying again."); return true; }
    if (!["ready", "pending"].includes(snapshot.setup.status)) {
      const selected = await workspace(snapshot);
      if (!selected || canceled(ui)) return true;
      await client.slack.startSetup(identityId, selected.id);
    }
    let deadline = now() + (ui.waitMs ?? 300_000);
    while (!canceled(ui) && now() < deadline) {
      snapshot = await client.slack.listConnections(identityId);
      if (snapshot.setup?.errorCode === "outcome_unknown") { ui.note("App preparation could not be confirmed; it will not be repeated automatically."); return true; }
      if (snapshot.setup?.status === "needs_credentials") {
        if (!await p.confirm("Renew the workspace credentials?", false)) return true;
        const selected = await workspace(snapshot, true);
        if (!selected || canceled(ui)) return true;
        await client.slack.startSetup(identityId, selected.id);
        deadline = now() + (ui.waitMs ?? 300_000);
      } else if (snapshot.setup?.status === "ready") break;
      else if (snapshot.setup?.status !== "pending") { ui.note("Slack app preparation stopped. Check setup in the Inkbox Console."); return true; }
      await delay(Math.min(3000, Math.max(0, deadline - now())));
    }
    if (canceled(ui) || snapshot.setup?.status !== "ready") { ui.note("Slack preparation wait ended; rerun setup to continue."); return true; }
    const selected = snapshot.provisioningWorkspace;
    if (!selected) { ui.note("The prepared app's workspace could not be confirmed."); return true; }
    const installation = await client.slack.startInstallation(identityId, { workspaceId: selected.workspaceId });
    await ui.installation(installation.authorizationUrl, installation.expiresAt);
    deadline = now() + (ui.waitMs ?? 300_000);
    while (!canceled(ui) && now() < deadline) {
      snapshot = await client.slack.listConnections(identityId);
      if (snapshot.connections.some((c) => c.identityId === identityId && c.workspaceId === selected.workspaceId && c.status === "connected")) { ui.note("Slack workspace connection confirmed."); return true; }
      await delay(Math.min(3000, Math.max(0, deadline - now())));
    }
    ui.note("Slack installation wait ended without a confirmed connection; rerun setup to continue.");
  } catch {
    ui.note("Slack setup could not complete. Existing channels are unchanged; check Slack setup before retrying.");
    return verified ? true : previous;
  }
  return true;
}
