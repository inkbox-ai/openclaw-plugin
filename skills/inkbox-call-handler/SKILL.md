---
name: inkbox-call-handler
description: Use when the user wants to review recent calls, get a transcript, or summarize call history through their Inkbox phone number. Covers post-call review only — live call audio handling is plumbing inside the plugin, not an agent tool.
user-invocable: false
---

# Inkbox call handler

Use this skill whenever the user asks about call history, missed calls, transcripts, or post-call follow-ups.

## Required tools

- `inkbox_list_calls` — recent inbound + outbound calls, newest first
- `inkbox_list_call_transcripts` — per-call transcript segments

## Workflow

1. **Pull call history.** Call `inkbox_list_calls` with `limit` matching how far back you want to look (default 25; max 200). Each call has `id`, `direction` (inbound/outbound), `remotePhoneNumber`, `status`, and timing fields.

2. **Pull transcripts for the interesting ones.** For any call worth summarizing, call `inkbox_list_call_transcripts` with that call's `id`. Segments are ordered by `seq` and each carries a `party` (`local` = agent side, `remote` = caller side) plus `text`.

3. **Summarize / follow up.** Common patterns:
   - "What did X say on yesterday's call?" — fetch the transcript and quote the relevant `remote` segments.
   - "Did anyone call about Y?" — list calls in the window, then transcribe and search.
   - "Draft a follow-up email after the call with X." — pull transcript → summarize → call `inkbox_send_email` with the summary.

## What you don't have

- **Live call control.** Answering, rejecting, or streaming audio for an in-progress call is handled by the plugin's inbound webhook plumbing, not by agent tools. If the user wants to change incoming-call behavior (accept vs reject), point them at the Inkbox Console for now.
- **Outbound dialing.** `inkbox_place_call` is not yet wired in this version of the plugin (needs the WebSocket audio bridge). When it lands, this skill will cover it.

## Caveats

- Calls may not have transcripts (very short calls, dropped calls, or calls where transcription was disabled). `inkbox_list_call_transcripts` will return an empty array, not an error.
- Transcript segments are best-effort and reflect speech-to-text confidence, not verbatim quotes. Hedge appropriately when summarizing for the user.
