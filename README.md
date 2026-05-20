# @inkbox/openclaw-plugin

Inkbox plugin for [OpenClaw](https://openclaw.ai). Adds tools that let the agent send email and SMS through your Inkbox identity.

> Status: early scaffold. Two outbound tools wired (`inkbox_send_email`, `inkbox_send_sms`). Inbound webhooks, CLI setup wizard, and full channel-plugin shape are next.

## Install (development)

The fastest dev loop is a local linked install — no publish required.

```bash
git clone https://github.com/inkbox-ai/openclaw-plugin.git
cd openclaw-plugin
npm install

# Link into your local OpenClaw
openclaw plugins install --link ./
```

After linking, edit `index.ts` and reload the session — OpenClaw picks up changes without reinstalling.

## Configure

Add your Inkbox credentials to OpenClaw's config under `plugins.entries.inkbox.config`:

```json
{
  "plugins": {
    "entries": {
      "inkbox": {
        "config": {
          "apiKey": "ApiKey_xxxxxxxxxxxx",
          "identity": "my-agent-handle"
        }
      }
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `apiKey` | yes | Inkbox API key. Create one in the [Inkbox Console](https://inkbox.ai/console). |
| `identity` | yes | Agent identity handle (3–63 lowercase alphanum/dash). |
| `baseUrl` | no | Override API base. Defaults to `https://inkbox.ai`. |
| `signingKey` | no | Webhook HMAC secret. Required once inbound webhooks land. |

## Tools

| Tool | What it does |
|---|---|
| `inkbox_send_email` | Send an email from the configured identity's mailbox. Supports cc/bcc and reply threading. |
| `inkbox_send_sms` | Send an SMS from the configured identity's phone number (E.164). |

Enable in your OpenClaw config:

```json5
{
  tools: { allow: ["inkbox"] }  // allow all tools from this plugin
}
```

## Roadmap

- [ ] `registerHttpRoute` for inbound email/SMS webhooks with HMAC verification
- [ ] `inkbox_place_call` voice tool
- [ ] `openclaw inkbox setup` CLI wizard (port of the Hermes Agent flow)
- [ ] Channel-plugin shape so inbound webhook events open OpenClaw sessions
- [ ] ClawHub publishing (`clawhub:inkbox/openclaw-plugin`)

## License

MIT
