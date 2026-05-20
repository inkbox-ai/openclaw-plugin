import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

// Contacts are an org-level address book filtered server-side by per-identity
// access grants. With an agent-scoped key, list/lookup/get already return only
// the contacts this identity has access to — we don't filter client-side.
// Grant management (create/revoke access) stays admin-only and is not exposed.
export function registerContactTools(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_lookup_contact",
    description:
      "Reverse-lookup contacts by email or phone. Exactly one filter must be provided — email, phone, emailDomain, emailContains, or phoneContains. Returns contacts this identity has access to.",
    parameters: Type.Object({
      email: Type.Optional(Type.String({ description: "Exact email address." })),
      phone: Type.Optional(Type.String({ description: "Exact E.164 phone number." })),
      emailDomain: Type.Optional(
        Type.String({ description: "Match by email domain (e.g. 'example.com')." }),
      ),
      emailContains: Type.Optional(
        Type.String({ description: "Substring match on email address." }),
      ),
      phoneContains: Type.Optional(
        Type.String({ description: "Substring match on phone number." }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const results = await inkbox.contacts.lookup(params);
        return toolText(
          formatWithHeader(`Found ${results.length} contact(s).`, results),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_contact",
    description:
      "Fetch a single contact by UUID. Returns the full contact record (names, emails, phones, addresses, vCard fields).",
    parameters: Type.Object({
      contactId: Type.String({ description: "UUID of the contact." }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const contact = await inkbox.contacts.get(params.contactId);
        return toolText(formatJson(contact));
      });
    },
  });

  api.registerTool({
    name: "inkbox_list_contacts",
    description:
      "List contacts this identity has access to. Optional free-text search via `q`; results scoped by per-identity grants.",
    parameters: Type.Object({
      q: Type.Optional(
        Type.String({
          description: "Free-text search across names/emails/phones.",
        }),
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
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const contacts = await inkbox.contacts.list({
          q: params.q,
          order: params.order,
          limit: params.limit ?? 50,
          offset: params.offset ?? 0,
        });
        return toolText(
          formatWithHeader(`Returned ${contacts.length} contact(s).`, contacts),
        );
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_export_contact_vcard",
      description:
        "Export a single contact as a vCard 4.0 string. Useful for handing a contact off to another system or saving to disk.",
      parameters: Type.Object({
        contactId: Type.String({ description: "UUID of the contact to export." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const vcf = await inkbox.contacts.vcards.export(params.contactId);
          return toolText(`vCard for contact ${params.contactId}:\n\n${vcf}`);
        });
      },
    },
    { optional: true },
  );
}
