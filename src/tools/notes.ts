import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

// Notes are free-form admin-created records with per-identity access grants
// (no wildcards). With an agent-scoped key, list/get auto-filter to
// access-granted notes. Create / update / delete go through the same
// access boundary: the agent can write its own notes; admins grant
// visibility to others if needed.
export function registerNoteTools(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_notes",
    description:
      "List notes this identity has access to. Optional free-text search via `q`.",
    parameters: Type.Object({
      q: Type.Optional(
        Type.String({ description: "Free-text search across title + body." }),
      ),
      order: Type.Optional(
        Type.Union(
          [Type.Literal("recent"), Type.Literal("name")],
          { description: "Sort order. Defaults to recent." },
        ),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const notes = await inkbox.notes.list({
          q: params.q,
          order: params.order,
          limit: params.limit ?? 50,
        });
        return toolText(
          formatWithHeader(`Returned ${notes.length} note(s).`, notes),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_note",
    description: "Fetch a single note by UUID.",
    parameters: Type.Object({
      noteId: Type.String({ description: "UUID of the note." }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const note = await inkbox.notes.get(params.noteId);
        return toolText(formatJson(note));
      });
    },
  });

  api.registerTool({
    name: "inkbox_create_note",
    description:
      "Create a new note. The body is required; title is optional. Visibility follows per-identity access grants set in the Inkbox Console.",
    parameters: Type.Object({
      body: Type.String({
        minLength: 1,
        description: "Note body (free-form text or markdown).",
      }),
      title: Type.Optional(
        Type.String({ description: "Optional title." }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const note = await inkbox.notes.create({
          body: params.body,
          title: params.title,
        });
        return toolText(`Created note id=${note.id}.`);
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_update_note",
      description:
        "Update a note's title or body. Pass title=null to clear the title (body cannot be cleared).",
      parameters: Type.Object({
        noteId: Type.String({ description: "UUID of the note to update." }),
        title: Type.Optional(
          Type.Union(
            [Type.String(), Type.Null()],
            { description: "New title, or null to clear." },
          ),
        ),
        body: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const updates: { title?: string | null; body?: string } = {};
          if (params.title !== undefined) updates.title = params.title;
          if (params.body !== undefined) updates.body = params.body;
          await inkbox.notes.update(params.noteId, updates as any);
          return toolText(`Updated note ${params.noteId}.`);
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_delete_note",
      description: "Delete a note by UUID. Irreversible.",
      parameters: Type.Object({
        noteId: Type.String({ description: "UUID of the note to delete." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          await inkbox.notes.delete(params.noteId);
          return toolText(`Deleted note ${params.noteId}.`);
        });
      },
    },
    { optional: true },
  );
}
