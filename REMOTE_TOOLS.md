# Remote Inkbox tools

Claimed identities use `inkbox_remote_tools` to discover the current catalog and
`inkbox_remote_call` to execute its tools. Discovery returns complete JSON schemas,
annotations and output contracts. The active catalog stays fixed for one native
turn and refreshes at the next turn. Calls return the complete MCP result,
including structured content. A failed refresh or call never selects an older
local implementation automatically.

The relay is deliberate: native tool registration is synchronous, so it cannot
load a remote catalog before returning native tool definitions. Catalog discovery
and execution are ordinary native tools, with stable native session/call identity
and the host's approval hook. Tool annotations never grant permission. Standalone
calls require native approval; admitted incoming turns retain channel automation.
Managed Ask applies to native local tools and remote tools alike. Explicit YOLO
applies only to the current managed turn. Saved settings are not rewritten.

| Capability | Execution and retained behavior |
| --- | --- |
| Current catalog, including mail, messages, contacts, notes and calls | Remote MCP with complete schema validation and current identity authority. |
| Legacy contact lookup/list/get/create/update/delete names | Delegate to the corresponding remote tools, retaining labeled contact values and stable mutation identity. |
| Channel send/reply helpers | Retain local file staging, formatting, source ownership and channel receipts. General remote sends remain available. |
| Historical read/list helpers | Retain their existing date filters, raw message access, conversation selectors and transcript behavior. |
| Voice and live-call controls | Retain native callbacks and local connections. |
| A2A task callbacks and delegation | Retain task ownership, progress, cancellation and caller routing. |
| Vault, local files and media | Remain local where decryption or host access is required. |

Admin and unclaimed credentials retain supported local tools and setup. Failed or
unknown credential checks cannot grant remote access. Existing configuration and
conversation history remain intact.

`inkbox_reply_current` sends a terminal text reply to the admitted email or direct
SMS source. It accepts text only; the destination comes from the original message.
A verified accepted receipt suppresses the automatic final reply. A submitted but
unconfirmed result also withholds automatic delivery until reconciliation. A
rejected preparation permits another reply. General sends are progress and never
claim terminal ownership. Other channel helpers retain their existing receipts.

Private call histories are scoped by origin, identity and native session. They
persist continuation identity before execution and revalidate ownership before a
retry. Keep histories until the corresponding session and outstanding deliveries
are retired. Do not delete them to retry an uncertain send.

Native contracts are tested against OpenClaw 2026.5.27. Source development uses the
pinned SDK revision in `pnpm-lock.yaml`; the package dependency requires SDK 0.7.38
or later. Building this branch does not publish that SDK version.
