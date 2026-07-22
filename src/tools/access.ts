import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

export function registerIdentityAccessTools(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_list_note_access",
      description:
        "List which Inkbox identities can see a note. Use before granting or revoking cross-identity note access.",
      parameters: Type.Object({
        noteId: Type.String({ description: "Note UUID." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const grants = await inkbox.notes.access.list(params.noteId);
          return toolText(formatWithHeader(`Returned ${grants.length} note access grant(s).`, grants));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_grant_note_access",
      description: "Grant an Inkbox identity access to a note.",
      parameters: Type.Object({
        noteId: Type.String({ description: "Note UUID." }),
        identityId: Type.String({ description: "Agent identity UUID to grant." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const grant = await inkbox.notes.access.grant(params.noteId, params.identityId);
          return toolText(formatJson(grant));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_revoke_note_access",
      description: "Revoke one Inkbox identity's access to a note.",
      parameters: Type.Object({
        noteId: Type.String({ description: "Note UUID." }),
        identityId: Type.String({ description: "Agent identity UUID to revoke." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          await inkbox.notes.access.revoke(params.noteId, params.identityId);
          return toolText(`Revoked identity ${params.identityId} access to note ${params.noteId}.`);
        });
      },
    },
    { optional: true },
  );
}
