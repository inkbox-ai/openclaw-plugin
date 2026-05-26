---
name: inkbox-call-handler
description: Use when the user wants to place a call, review recent calls, get a transcript, summarize call history, or handle an active Inkbox voice-call turn through their Inkbox phone number.
user-invocable: false
---

# Inkbox call handler

Use this skill whenever the user asks you to call someone, responds during an active voice call, or asks about call history, missed calls, transcripts, or post-call follow-ups.

## Required tools

- `inkbox_list_calls` — recent inbound + outbound calls, newest first
- `inkbox_list_call_transcripts` — per-call transcript segments

## Optional tools

- `inkbox_place_call` — place an outbound call from the configured Inkbox identity. Use it when the user asks you to call them or another allowed recipient.

## Workflow

1. **Place outbound calls when requested.** If the user asks you to call a phone number or contact, resolve the recipient, then call `inkbox_place_call` with `toNumber`. Do not invent or request a `clientWebsocketUrl`; the plugin supplies the active Inkbox call bridge when the channel gateway is running.

2. **Stay in voice during active call turns.** If the inbound message is marked as an Inkbox voice call transcript, reply normally in text. The plugin speaks that reply over Inkbox TTS on the active call. Do not send SMS or email as the response to voice unless the user explicitly asks for a separate follow-up.

3. **Pull call history.** Call `inkbox_list_calls` with `limit` matching how far back you want to look (default 25; max 200). Each call has `id`, `direction` (inbound/outbound), `remotePhoneNumber`, `status`, and timing fields.

4. **Pull transcripts for the interesting ones.** For any call worth summarizing, call `inkbox_list_call_transcripts` with that call's `id`. Segments are ordered by `seq` and each carries a `party` (`local` = agent side, `remote` = caller side) plus `text`.

5. **Summarize / follow up.** Common patterns:
   - "What did X say on yesterday's call?" — fetch the transcript and quote the relevant `remote` segments.
   - "Did anyone call about Y?" — list calls in the window, then transcribe and search.
   - "Draft a follow-up email after the call with X." — pull transcript → summarize → call `inkbox_send_email` with the summary.

## Caveats

- Answering/rejecting inbound calls and the raw audio stream are plugin plumbing, not agent tools.
- Calls may not have transcripts (very short calls, dropped calls, or calls where transcription was disabled). `inkbox_list_call_transcripts` will return an empty array, not an error.
- Transcript segments are best-effort and reflect speech-to-text confidence, not verbatim quotes. Hedge appropriately when summarizing for the user.

## When you need more — raw Inkbox docs

If something here doesn't match what you're seeing, or you need API behavior this skill doesn't describe (call lifecycle states, transcript shape, rate limits, recording fields), go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Prefer fetching these over guessing.
