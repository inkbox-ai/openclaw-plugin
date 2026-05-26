const smsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    batchDelayMs: {
      type: "integer",
      minimum: 0,
      description: "Wait this many ms before flushing inbound SMS fragments. 0 disables batching.",
    },
    maxMessages: {
      type: "integer",
      minimum: 1,
      description: "Max fragments per batch before forced flush.",
    },
    maxChars: {
      type: "integer",
      minimum: 1,
      description: "Max total chars per batch before forced flush.",
    },
  },
};

const vaultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    keyEnvVar: {
      type: "string",
      description: "Environment variable used for the Inkbox vault unlock key.",
    },
  },
};

export const inkboxAccountConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      description: "Enable this Inkbox account.",
    },
    name: {
      type: "string",
      description: "Human label for this account.",
    },
    defaultTo: {
      type: "string",
      description: "Default outbound target for the shared message tool.",
    },
    apiKey: {
      type: "string",
      description: "Inkbox API key.",
    },
    identity: {
      type: "string",
      description: "Agent identity handle to send from.",
    },
    baseUrl: {
      type: "string",
      description: "Override Inkbox API base URL.",
    },
    signingKey: {
      type: "string",
      description: "Webhook HMAC signing secret.",
    },
    tunnelName: {
      type: "string",
      description: "Override the Inkbox tunnel name. Defaults to the identity handle.",
    },
    publicUrl: {
      type: "string",
      description:
        "Public OpenClaw base URL. If omitted, the plugin uses an Inkbox tunnel.",
    },
    callWebsocketUrl: {
      type: "string",
      description:
        "Explicit outbound-call media WebSocket URL. If omitted, tunnel mode derives it from tunnelName/identity.",
    },
    vault: vaultSchema,
    allowedRecipients: {
      type: "array",
      items: { type: "string" },
      description: "Outbound email/phone allowlist.",
    },
    allowedInboundContactIds: {
      type: "array",
      items: { type: "string" },
      description: "Inbound Inkbox contact-id allowlist.",
    },
    sms: smsSchema,
  },
} as const;

export const inkboxChannelConfigSchema = {
  schema: {
    ...inkboxAccountConfigJsonSchema,
    properties: {
      ...inkboxAccountConfigJsonSchema.properties,
      defaultAccount: {
        type: "string",
        description: "Default Inkbox account id.",
      },
      accounts: {
        type: "object",
        additionalProperties: inkboxAccountConfigJsonSchema,
        description: "Named Inkbox accounts.",
      },
    },
  },
};
