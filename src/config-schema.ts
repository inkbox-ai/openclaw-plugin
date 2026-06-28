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

const voiceRealtimeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      description:
        "Enable raw phone-media bridging through an OpenClaw realtime voice provider.",
    },
    provider: {
      type: "string",
      description: "Realtime voice provider id, for example openai.",
    },
    model: {
      type: "string",
      description: "Provider realtime model, for example gpt-realtime.",
    },
    voice: {
      type: "string",
      description: "Provider voice, for example alloy, cedar, or marin.",
    },
    instructions: {
      type: "string",
      description: "Additional realtime voice instructions.",
    },
    toolPolicy: {
      type: "string",
      enum: ["safe-read-only", "owner", "none"],
      description:
        "Realtime consult tool policy. owner lets the OpenClaw consult use the normal agent tool policy.",
    },
    consultPolicy: {
      type: "string",
      enum: ["auto", "substantive", "always"],
      description:
        "Guidance for when the realtime model should call consult_agent.",
    },
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: true,
      },
      description:
        "Provider-owned realtime config keyed by provider id, such as { openai: { apiKey, model, voice } }.",
    },
    fallbackToInkboxSttTts: {
      type: "boolean",
      description:
        "Fall back to Inkbox-managed STT/TTS when realtime auth/provider config is unavailable. Defaults to true.",
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
    voiceTranscriptCoalesceMs: {
      type: "integer",
      minimum: 0,
      description:
        "Wait this many ms before dispatching final voice transcript segments so clipped caller phrases can be coalesced. Defaults to 1200.",
    },
    voiceAgentPrewarm: {
      type: "boolean",
      description:
        "Run a hidden no-delivery agent turn when the gateway starts so the first caller turn does not pay OpenClaw/Codex cold-start latency. Defaults to true.",
    },
    voiceAgentPrewarmTtlMs: {
      type: "integer",
      minimum: 0,
      description:
        "Minimum time between hidden voice agent warmups. Defaults to 600000.",
    },
    voiceAgentPrewarmTimeoutMs: {
      type: "integer",
      minimum: 1,
      description:
        "Maximum time to let the hidden voice agent warmup run before aborting. Defaults to 70000.",
    },
    voiceRealtime: voiceRealtimeSchema,
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
