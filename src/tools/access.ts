import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolError, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function registerIdentityAccessTools(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_list_contact_access",
      description:
        "List which Inkbox identities can see a contact. Use before granting or revoking cross-identity contact access.",
      parameters: Type.Object({
        contactId: Type.String({ description: "Contact UUID." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const grants = await inkbox.contacts.access.list(params.contactId);
          return toolText(formatWithHeader(`Returned ${grants.length} contact access grant(s).`, grants));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_grant_contact_access",
      description:
        "Grant an Inkbox identity access to a contact, or grant wildcard access so every active identity can see it.",
      parameters: Type.Object({
        contactId: Type.String({ description: "Contact UUID." }),
        identityId: Type.Optional(Type.String({ description: "Agent identity UUID to grant." })),
        wildcard: Type.Optional(
          Type.Boolean({
            description: "Set true to replace specific grants with wildcard access.",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identityId = hasString(params.identityId) ? params.identityId.trim() : undefined;
          if (params.wildcard === true && identityId) {
            return toolError("Pass either identityId or wildcard=true, not both.");
          }
          if (params.wildcard !== true && !identityId) {
            return toolError("identityId is required unless wildcard=true.");
          }
          const inkbox = await runtime.getClient();
          const grant = await inkbox.contacts.access.grant(params.contactId, {
            identityId,
            wildcard: params.wildcard === true,
          });
          return toolText(formatWithHeader("Granted contact access.", grant));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_revoke_contact_access",
      description: "Revoke one Inkbox identity's access to a contact.",
      parameters: Type.Object({
        contactId: Type.String({ description: "Contact UUID." }),
        identityId: Type.String({ description: "Agent identity UUID to revoke." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          await inkbox.contacts.access.revoke(params.contactId, params.identityId);
          return toolText(`Revoked identity ${params.identityId} access to contact ${params.contactId}.`);
        });
      },
    },
    { optional: true },
  );

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
