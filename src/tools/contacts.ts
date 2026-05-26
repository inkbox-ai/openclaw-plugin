import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

const contactEmailSchema = Type.Object({
  value: Type.String({ description: "Email address." }),
  label: Type.Optional(Type.String({ description: "Optional label, e.g. work/home." })),
  isPrimary: Type.Optional(Type.Boolean({ description: "Whether this is the primary email." })),
});

const contactPhoneSchema = Type.Object({
  value: Type.String({ description: "E.164 phone number, e.g. +15551234567." }),
  label: Type.Optional(Type.String({ description: "Optional label, e.g. mobile/work." })),
  isPrimary: Type.Optional(Type.Boolean({ description: "Whether this is the primary phone." })),
});

function normalizeContactEmails(emails: any[] | undefined) {
  return emails?.map((entry) => ({
    value: entry.value,
    label: entry.label ?? null,
    isPrimary: Boolean(entry.isPrimary),
  }));
}

function normalizeContactPhones(phones: any[] | undefined) {
  return phones?.map((entry) => ({
    value: entry.value,
    label: entry.label ?? null,
    isPrimary: Boolean(entry.isPrimary),
  }));
}

function buildContactWritePayload(params: any) {
  const payload: Record<string, unknown> = {};
  for (const key of [
    "preferredName",
    "givenName",
    "familyName",
    "companyName",
    "jobTitle",
    "notes",
  ]) {
    if (params[key] !== undefined) {
      payload[key] = params[key];
    }
  }
  if (params.emails !== undefined) {
    payload.emails = normalizeContactEmails(params.emails);
  }
  if (params.phones !== undefined) {
    payload.phones = normalizeContactPhones(params.phones);
  }
  return payload;
}

// Contacts are an org-level address book filtered server-side by per-identity
// access grants. With an agent-scoped key, list/lookup/get already return only
// the contacts this identity has access to — we don't filter client-side.
// Grant management stays admin-only and is not exposed.
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

  api.registerTool({
    name: "inkbox_create_contact",
    description:
      "Create an Inkbox address-book contact. Use when the user asks to save a person/contact in Inkbox. Include phone/email when known; notes can hold free-form context.",
    parameters: Type.Object({
      preferredName: Type.Optional(Type.String({ description: "Display/preferred name." })),
      givenName: Type.Optional(Type.String({ description: "Given/first name." })),
      familyName: Type.Optional(Type.String({ description: "Family/last name." })),
      companyName: Type.Optional(Type.String({ description: "Company or organization." })),
      jobTitle: Type.Optional(Type.String({ description: "Job title." })),
      notes: Type.Optional(Type.String({ description: "Free-form contact notes." })),
      emails: Type.Optional(Type.Array(contactEmailSchema, { description: "Email addresses." })),
      phones: Type.Optional(Type.Array(contactPhoneSchema, { description: "Phone numbers." })),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const inkbox = await runtime.getClient();
        const contact = await inkbox.contacts.create(buildContactWritePayload(params) as any);
        return toolText(formatWithHeader(`Created contact id=${contact.id}.`, contact));
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_update_contact",
      description:
        "Update an Inkbox address-book contact by UUID. Use after lookup/get when the user asks to add or correct contact details.",
      parameters: Type.Object({
        contactId: Type.String({ description: "UUID of the contact to update." }),
        preferredName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        givenName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        familyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        companyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        jobTitle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        emails: Type.Optional(Type.Union([Type.Array(contactEmailSchema), Type.Null()])),
        phones: Type.Optional(Type.Union([Type.Array(contactPhoneSchema), Type.Null()])),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const payload = buildContactWritePayload(params);
          if (params.emails === null) payload.emails = null;
          if (params.phones === null) payload.phones = null;
          const contact = await inkbox.contacts.update(params.contactId, payload as any);
          return toolText(formatWithHeader(`Updated contact id=${contact.id}.`, contact));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_delete_contact",
      description: "Delete an Inkbox address-book contact by UUID. Irreversible.",
      parameters: Type.Object({
        contactId: Type.String({ description: "UUID of the contact to delete." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          await inkbox.contacts.delete(params.contactId);
          return toolText(`Deleted contact ${params.contactId}.`);
        });
      },
    },
    { optional: true },
  );

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
