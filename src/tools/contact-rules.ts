import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolError, toolText, type ToolTextResult } from "../errors.js";
import { formatWithHeader } from "../format.js";

const ruleStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("paused")]);
const mailRuleActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("block")]);
const mailRuleMatchTypeSchema = Type.Union([
  Type.Literal("exact_email"),
  Type.Literal("domain"),
]);
const phoneRuleActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("block")]);
const phoneRuleMatchTypeSchema = Type.Literal("exact_number");

type MailboxRef = { ok: true; emailAddress: string } | { ok: false; result: ToolTextResult };
type PhoneRef = { ok: true; phoneNumberId: string } | { ok: false; result: ToolTextResult };

async function requireMailbox(runtime: InkboxRuntime): Promise<MailboxRef> {
  const identity = await runtime.getIdentity();
  if (!identity.mailbox?.emailAddress) {
    return {
      ok: false,
      result: toolError("This Inkbox identity has no mailbox, so mail contact rules are unavailable."),
    };
  }
  return { ok: true, emailAddress: identity.mailbox.emailAddress };
}

async function requirePhoneNumber(runtime: InkboxRuntime): Promise<PhoneRef> {
  const identity = await runtime.getIdentity();
  if (!identity.phoneNumber?.id) {
    return {
      ok: false,
      result: toolError("This Inkbox identity has no phone number, so phone contact rules are unavailable."),
    };
  }
  return { ok: true, phoneNumberId: identity.phoneNumber.id };
}

export function registerContactRuleTools(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_list_mail_contact_rules",
      description:
        "List allow/block rules for the configured Inkbox identity's mailbox. Use before changing email sender allowlists or blocklists.",
      parameters: Type.Object({
        action: Type.Optional(mailRuleActionSchema),
        matchType: Type.Optional(mailRuleMatchTypeSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const mailbox = await requireMailbox(runtime);
          if (!mailbox.ok) return mailbox.result;
          const inkbox = await runtime.getClient();
          const rules = await inkbox.mailContactRules.list(mailbox.emailAddress, {
            action: params.action,
            matchType: params.matchType,
            limit: params.limit ?? 50,
            offset: params.offset ?? 0,
          });
          return toolText(formatWithHeader(`Returned ${rules.length} mail rule(s).`, rules));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_create_mail_contact_rule",
      description:
        "Create a mailbox allow/block rule for one sender email address or domain. Use when the user asks to block or allow inbound email senders.",
      parameters: Type.Object({
        action: mailRuleActionSchema,
        matchType: mailRuleMatchTypeSchema,
        matchTarget: Type.String({
          minLength: 1,
          description: "Email address for exact_email or bare domain for domain.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const mailbox = await requireMailbox(runtime);
          if (!mailbox.ok) return mailbox.result;
          const inkbox = await runtime.getClient();
          const rule = await inkbox.mailContactRules.create(mailbox.emailAddress, {
            action: params.action,
            matchType: params.matchType,
            matchTarget: params.matchTarget,
          });
          return toolText(formatWithHeader(`Created mail contact rule id=${rule.id}.`, rule));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_update_mail_contact_rule",
      description:
        "Update a mailbox contact rule's action or status. Use status=paused to temporarily disable a rule without deleting it.",
      parameters: Type.Object({
        ruleId: Type.String({ description: "Mail contact rule UUID." }),
        action: Type.Optional(mailRuleActionSchema),
        status: Type.Optional(ruleStatusSchema),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const mailbox = await requireMailbox(runtime);
          if (!mailbox.ok) return mailbox.result;
          const inkbox = await runtime.getClient();
          const rule = await inkbox.mailContactRules.update(mailbox.emailAddress, params.ruleId, {
            action: params.action,
            status: params.status,
          });
          return toolText(formatWithHeader(`Updated mail contact rule id=${rule.id}.`, rule));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_delete_mail_contact_rule",
      description: "Delete a mailbox contact rule by UUID.",
      parameters: Type.Object({
        ruleId: Type.String({ description: "Mail contact rule UUID." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const mailbox = await requireMailbox(runtime);
          if (!mailbox.ok) return mailbox.result;
          const inkbox = await runtime.getClient();
          await inkbox.mailContactRules.delete(mailbox.emailAddress, params.ruleId);
          return toolText(`Deleted mail contact rule ${params.ruleId}.`);
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_list_phone_contact_rules",
      description:
        "List allow/block rules for the configured Inkbox identity's phone number. Rules affect inbound SMS and calls.",
      parameters: Type.Object({
        action: Type.Optional(phoneRuleActionSchema),
        matchType: Type.Optional(phoneRuleMatchTypeSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const phone = await requirePhoneNumber(runtime);
          if (!phone.ok) return phone.result;
          const inkbox = await runtime.getClient();
          const rules = await inkbox.phoneContactRules.list(phone.phoneNumberId, {
            action: params.action,
            matchType: params.matchType,
            limit: params.limit ?? 50,
            offset: params.offset ?? 0,
          });
          return toolText(formatWithHeader(`Returned ${rules.length} phone rule(s).`, rules));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_create_phone_contact_rule",
      description:
        "Create a phone-number allow/block rule for an E.164 number. Use when the user asks to block or allow inbound SMS/calls.",
      parameters: Type.Object({
        action: phoneRuleActionSchema,
        matchType: Type.Optional(phoneRuleMatchTypeSchema),
        matchTarget: Type.String({
          minLength: 1,
          description: "E.164 phone number, e.g. +15551234567.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const phone = await requirePhoneNumber(runtime);
          if (!phone.ok) return phone.result;
          const inkbox = await runtime.getClient();
          const rule = await inkbox.phoneContactRules.create(phone.phoneNumberId, {
            action: params.action,
            matchType: params.matchType,
            matchTarget: params.matchTarget,
          });
          return toolText(formatWithHeader(`Created phone contact rule id=${rule.id}.`, rule));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_update_phone_contact_rule",
      description:
        "Update a phone contact rule's action or status. Use status=paused to temporarily disable a rule without deleting it.",
      parameters: Type.Object({
        ruleId: Type.String({ description: "Phone contact rule UUID." }),
        action: Type.Optional(phoneRuleActionSchema),
        status: Type.Optional(ruleStatusSchema),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const phone = await requirePhoneNumber(runtime);
          if (!phone.ok) return phone.result;
          const inkbox = await runtime.getClient();
          const rule = await inkbox.phoneContactRules.update(phone.phoneNumberId, params.ruleId, {
            action: params.action,
            status: params.status,
          });
          return toolText(formatWithHeader(`Updated phone contact rule id=${rule.id}.`, rule));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_delete_phone_contact_rule",
      description: "Delete a phone contact rule by UUID.",
      parameters: Type.Object({
        ruleId: Type.String({ description: "Phone contact rule UUID." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const phone = await requirePhoneNumber(runtime);
          if (!phone.ok) return phone.result;
          const inkbox = await runtime.getClient();
          await inkbox.phoneContactRules.delete(phone.phoneNumberId, params.ruleId);
          return toolText(`Deleted phone contact rule ${params.ruleId}.`);
        });
      },
    },
    { optional: true },
  );
}
