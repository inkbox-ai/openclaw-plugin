# Live CI

Live Actions use shared test identities and serialized execution. Ready same-repository pull requests and manual dispatches can run the suites; the full-stack Action also follows a successful canary run on `main`.

## Full stack e2e

Runs the reusable live Actions in order and fails unless every suite succeeds.

### Channels suite

**Proves:** Both channel matrix legs pass. **Flow:** 1. Run channels. 2. Continue even if it fails so later suites still produce evidence. 3. Preserve its result for the aggregate gate.

### Agent2Agent suite

**Proves:** All four protocol scenarios pass. **Flow:** 1. Wait for channels. 2. Run the serialized Agent2Agent matrix. 3. Preserve its result.

### Voice suite

**Proves:** The configured voice scenarios pass, including the inbound diagnostic in this Action. **Flow:** 1. Wait for Agent2Agent. 2. Run the serialized voice matrix. 3. Preserve its result.

### External-events suite

**Proves:** Signed dispatch and forged-signature rejection pass. **Flow:** 1. Wait for voice. 2. Run external-event tests. 3. Preserve the result.

### Aggregate gate

**Proves:** No required live suite failed or skipped. **Flow:** 1. Read all four results. 2. Require each to equal `success`. 3. Fail otherwise.

## Live — Agent2Agent

Uses a real model and four serialized protocol scenarios.

### `inbound-single`

**Proves:** OpenClaw completes a one-turn inbound Agent2Agent task with the requested result. **Flow:** 1. A remote identity sends a tokenized task. 2. Wait for completion. 3. Find the token in task history.

### `inbound-multi`

**Proves:** OpenClaw pauses an inbound task for caller input and resumes it correctly. **Flow:** 1. Request input. 2. Supply a tokenized answer. 3. Require completed history to contain the answer and completion token.

### `outbound-single`

**Proves:** OpenClaw delegates a one-turn task and waits for the worker before completing its outer task. **Flow:** 1. Ask OpenClaw to delegate. 2. Complete the remote worker task. 3. Require the worker result in the outer history.

### `outbound-multi`

**Proves:** OpenClaw handles a delegated worker's input request before completing the outer task. **Flow:** 1. Delegate. 2. Have the worker request input. 3. Answer, complete the worker, and require its result in the outer history.

## Live — agent channels (email + SMS)

The `mock` and `real` matrix legs both collect `tests/live`. Labels below show which mode actually runs each test.

### `test_email_reachability` — mock

**Proves:** A deterministic model receives an email and returns a correlated, non-error reply. **Flow:** 1. Send a nonce email. 2. Poll its thread. 3. Require the mock marker and nonce.

### `test_basic_reply` — real

**Proves:** The real model returns a non-empty email reply. **Flow:** 1. Send an acknowledgement request. 2. Poll fresh agent email. 3. Reject error fallbacks and empty content.

### `test_reports_own_identity` — real

**Proves:** The agent can report identity data available to it. **Flow:** 1. Read expected values through the API. 2. Ask by email. 3. Match handle, email, and phone.

### `test_reports_sender_details` — real

**Proves:** The agent resolves the sender's contact card. **Flow:** 1. Ensure the sender contact exists. 2. Ask for its details. 3. Match stored name, email, and phone.

### `test_aware_of_inkbox_tools` — real

**Proves:** Contact lookup tools work through the real agent loop. **Flow:** 1. Create a nonce contact. 2. Ask the agent to look it up. 3. Require the hidden surname, then clean up.

### `test_contact_crud_tool_use` — opt-in, skipped in standard CI

**Proves:** When `LIVE_CONTACT_CRUD=1`, contact create, update, and delete tools work end to end. **Flow:** 1. Create a temporary contact. 2. Update and verify it. 3. Delete and verify absence.

### `test_sms_reachability` — mock

**Proves:** Deterministic SMS routing returns the mock response. **Flow:** 1. Send a fresh ping. 2. Poll a new inbound SMS. 3. Require the mock marker.

### `test_sms_basic_reply` — real

**Proves:** The real model returns a non-empty SMS reply. **Flow:** 1. Send a short request. 2. Correlate the fresh reply. 3. Reject error content.

### `test_sms_reports_own_identity` — real

**Proves:** The agent can report its email over SMS. **Flow:** 1. Read the expected mailbox. 2. Ask for identity data. 3. Require the email in the correlated reply.

### `test_sms_reports_sender_details` — real, data-dependent skip

**Proves:** The agent can report a known SMS sender's contact name. **Flow:** 1. Look up the sender card. 2. Skip if none exists. 3. Ask and match its stored name.

### `test_sms_aware_of_inkbox_tools` — real

**Proves:** Contact lookup tools work from an SMS turn. **Flow:** 1. Create a nonce contact. 2. Ask for a lookup. 3. Require the hidden surname, then clean up.

### `test_sms_retry_after_carrier_delivery_failure` — real, conditionally skipped

**Proves:** When the channels gateway exposes the local signed-webhook route, a retryable asynchronous SMS failure wakes the agent and produces a follow-up. **Flow:** 1. Establish the conversation. 2. Submit a signed failure event. 3. Skip if that route is unavailable; otherwise require a fresh reply and wake evidence.

### `test_sms_retry_after_internal_spam_block` — real

**Proves:** A synchronous content rejection reaches the agent. **Flow:** 1. Request content expected to be rejected. 2. Observe a retry wake, inline rejection, or safe delivered fallback. 3. Do not require an unsafe resend.

### `test_email_request_gets_sms_response` — real

**Proves:** An email request can produce a token-correlated SMS. **Flow:** 1. Email a request containing a nonce. 2. Poll fresh SMS from the agent. 3. Require the nonce.

### `test_sms_request_gets_email_response` — real

**Proves:** An SMS request can produce one correlated email row for each API owner without a wrong-channel SMS. **Flow:** 1. Snapshot both channels and owners. 2. Send a tokenized request. 3. Retry only a zero-side-effect turn and reject partial, stale, wrong-recipient, or duplicate results.

### `test_email_request_gets_call` — real

**Proves:** An email request creates matching fresh call legs with voicemail detection disabled. **Flow:** 1. Snapshot both call owners. 2. Ask the agent to call. 3. Permit a second request only after zero call effects.

### `test_sms_request_gets_call` — real

**Proves:** An SMS request creates matching fresh call legs with voicemail detection disabled. **Flow:** 1. Snapshot both call owners. 2. Send a fresh call request. 3. Reject partial or duplicate legs and retry only an empty turn.

### `test_email_recovery_retries_only_a_zero_side_effect_turn` — mock and real

**Proves:** Cross-channel email recovery classifies a no-effect turn as retryable. **Flow:** 1. Supply empty owner rows and no SMS. 2. Classify. 3. Require `empty`.

### `test_email_recovery_waits_for_second_owner_before_settlement` — mock and real

**Proves:** A one-owner email result remains pending. **Flow:** 1. Supply one driver row. 2. Omit the agent-owned row. 3. Require `pending`.

### `test_email_recovery_accepts_exact_one_current_token_for_both_owners` — mock and real

**Proves:** One current-token row on both email owners is accepted. **Flow:** 1. Supply one row per owner. 2. Match the current token and recipient. 3. Require `success`.

### `test_email_recovery_rejects_wrong_channel_side_effect` — mock and real

**Proves:** A wrong-channel SMS makes email recovery terminal. **Flow:** 1. Supply no email. 2. Add an SMS effect. 3. Require `terminal`.

### `test_email_recovery_rejects_wrong_content_and_recipient` — mock and real

**Proves:** Wrong email content or recipient cannot satisfy recovery. **Flow:** 1. Supply each invalid shape. 2. Classify. 3. Require terminal results.

### `test_email_recovery_rejects_duplicates_and_late_prior_token` — mock and real

**Proves:** Duplicate rows and prior-attempt tokens are terminal. **Flow:** 1. Supply duplicate or mixed-token rows. 2. Classify. 3. Reject both.

### `test_fresh_rows_require_new_owner_id_at_or_after_server_watermark` — mock and real

**Proves:** Freshness requires both a new row ID and a current server timestamp. **Flow:** 1. Supply stale-ID, stale-time, and fresh rows. 2. Filter. 3. Keep only the fresh row.

### `test_open_post_call_action_matches_marker_and_sms_intent_across_shapes` — mock and real

**Proves:** Open SMS actions match across supported object shapes and speech separators. **Flow:** 1. Build equivalent action shapes. 2. Normalize. 3. Match both.

### `test_open_post_call_action_rejects_closed_wrong_marker_and_non_sms_items` — mock and real

**Proves:** Closed, wrong-marker, and non-SMS actions do not authorize hosted settlement. **Flow:** 1. Build invalid actions. 2. Match. 3. Require none.

### `test_direct_contact_read_log_matching_accepts_both_formats_and_exact_call` — mock and real

**Proves:** Realtime contact-read evidence is bound to the exact call across supported log formats. **Flow:** 1. Supply two valid formats. 2. Match the call ID. 3. Reject wrong call and wrong event text.

### `test_hosted_marker_normalizes_asr_separators_without_unsafe_prefix` — mock and real

**Proves:** Speech separator differences preserve a hosted marker without requiring a fixed prefix. **Flow:** 1. Create a punctuation variant. 2. Normalize both forms. 3. Match the open SMS action.

### `test_post_call_action_diagnostics_are_content_free_and_redacted` — mock and real

**Proves:** Action mismatch diagnostics expose only counts, booleans, and lengths. **Flow:** 1. Insert sentinel content. 2. Build diagnostics. 3. Require no sentinel leakage.

### `test_live_voice_marker_is_deterministic_distinct_and_speech_safe` — mock and real

**Proves:** Generated five-word markers are deterministic, distinct, and drawn from the speech-tested vocabulary. **Flow:** 1. Generate representative markers. 2. Repeat generation. 3. Check word count, uniqueness, and vocabulary.

### `test_live_voice_marker_mapping_is_stable` — mock and real

**Proves:** A fixed token keeps its expected marker mapping. **Flow:** 1. Generate from the fixture token. 2. Split words. 3. Compare the stable sequence.

### `test_live_workflow_uses_canonical_hosted_action_stimulus_and_test_owned_hangup` — mock and real

**Proves:** The voice workflow supplies the canonical hosted request and leaves hangup ownership to pytest. **Flow:** 1. Read the workflow. 2. Match marker generation and stimulus. 3. Require the driver listen window.

### `test_every_call_capable_live_ci_gateway_disables_voicemail_detection` — mock and real

**Proves:** Every live workflow that configures a call-capable gateway explicitly disables voicemail detection. **Flow:** 1. Find call-capable workflows. 2. Inspect configuration. 3. Require the expected inventory and setting.

### `test_inbound_call_inkbox_tts_stt` — collected, skipped in channels

**Proves:** Nothing in the channels Action; this scenario requires the voice driver and `VOICE_SCENARIO=inbound_inkbox`. **Flow:** 1. Collect the test. 2. Observe the missing scenario selector. 3. Skip.

### `test_outbound_call_realtime` — collected, skipped in channels

**Proves:** Nothing in the channels Action; this scenario requires `VOICE_SCENARIO=outbound_realtime`. **Flow:** 1. Collect. 2. Observe the missing selector. 3. Skip.

### `test_outbound_call_realtime_direct_contact_lookup` — collected, skipped in channels

**Proves:** Nothing in the channels Action; this scenario requires `VOICE_SCENARIO=outbound_realtime_contact`. **Flow:** 1. Collect. 2. Observe the missing selector. 3. Skip.

### `test_outbound_call_hosted_and_settles_sms_once` — collected, skipped in channels

**Proves:** Nothing in the channels Action; this scenario requires `VOICE_SCENARIO=outbound_hosted` and a hosted marker. **Flow:** 1. Collect. 2. Observe the missing selector. 3. Skip.

### `test_signed_external_event_reaches_openclaw_dispatcher` — collected, skipped in channels

**Proves:** Nothing in the channels Action; its gateway lacks this external-event fixture's inputs. **Flow:** 1. Collect. 2. Observe missing suite-specific inputs. 3. Skip.

### `test_forged_github_signature_is_rejected_before_dispatch` — collected, skipped in channels

**Proves:** Nothing in the channels Action; its gateway lacks this provider fixture's inputs. **Flow:** 1. Collect. 2. Observe missing suite-specific inputs. 3. Skip.

### `test_valid_github_signature_reaches_openclaw_dispatcher` — collected, skipped in channels

**Proves:** Nothing in the channels Action; its gateway lacks this provider fixture's inputs. **Flow:** 1. Collect. 2. Observe missing suite-specific inputs. 3. Skip.

## Live — voice calls (Inkbox TTS/STT + realtime + Voice AI)

Uses a real model and real calls. The three outbound scenarios always run; `inbound_inkbox` is controlled by `include_inbound` and is enabled by the full-stack Action and by default for manual dispatch. Every matrix leg also runs all nine helper contracts.

### `test_inbound_call_inkbox_tts_stt` — conditional scenario

**Proves:** An inbound call uses Inkbox TTS/STT, carries two-way speech, and stores disabled voicemail detection. **Flow:** 1. Place a driver-owned inbound call. 2. Require both transcript parties. 3. Inspect the call policy and agent speech mode.

### `test_outbound_call_realtime`

**Proves:** A text request creates a fresh two-way Realtime call with Inkbox speech disabled and voicemail detection disabled. **Flow:** 1. Snapshot driver and agent call rows. 2. Request a callback. 3. Match the new call, transcript, speech flags, and policy.

### `test_outbound_call_realtime_direct_contact_lookup`

**Proves:** A Realtime call performs a direct contact read for its exact call and uses the expected speech mode and voicemail policy. **Flow:** 1. Seed caller and lookup contacts. 2. Request a call. 3. Correlate the direct read to the fresh agent call; transcript recitation is diagnostic.

### `test_outbound_call_hosted_and_settles_sms_once`

**Proves:** A fresh hosted call inherits saved authority, records the caller's marker-bearing SMS action, and completes one matching post-call SMS settlement to the authoritative caller during the observation window. It does not require the entire SMS body to equal the marker or rule out unrelated sends. **Flow:** 1. Correlate fresh call rows and verify mode, authority, reason, and voicemail policy. 2. Require marker-bearing transcript and open action before hangup. 3. Require a completed receipt and one fresh caller-targeted SMS whose normalized body contains the marker.

### `test_open_post_call_action_matches_marker_and_sms_intent_across_shapes`

**Proves:** Open SMS actions match across supported shapes and speech separators. **Flow:** 1. Build equivalent actions. 2. Normalize. 3. Match both.

### `test_open_post_call_action_rejects_closed_wrong_marker_and_non_sms_items`

**Proves:** Invalid action state, marker, or intent cannot authorize settlement. **Flow:** 1. Build invalid actions. 2. Match. 3. Require none.

### `test_direct_contact_read_log_matching_accepts_both_formats_and_exact_call`

**Proves:** Contact-read evidence remains bound to the exact call. **Flow:** 1. Supply supported formats. 2. Match the call. 3. Reject mismatches.

### `test_hosted_marker_normalizes_asr_separators_without_unsafe_prefix`

**Proves:** Speech separator changes preserve marker matching. **Flow:** 1. Create a spoken variant. 2. Normalize. 3. Match its action.

### `test_post_call_action_diagnostics_are_content_free_and_redacted`

**Proves:** Action diagnostics exclude source content. **Flow:** 1. Insert sentinels. 2. Build diagnostics. 3. Require only metadata.

### `test_live_voice_marker_is_deterministic_distinct_and_speech_safe`

**Proves:** Five-word markers are deterministic, distinct, and speech-safe. **Flow:** 1. Generate markers. 2. Repeat. 3. Validate their shape and vocabulary.

### `test_live_voice_marker_mapping_is_stable`

**Proves:** The fixture marker mapping is stable. **Flow:** 1. Generate. 2. Split. 3. Compare.

### `test_live_workflow_uses_canonical_hosted_action_stimulus_and_test_owned_hangup`

**Proves:** Workflow stimulus and hangup ownership match the live contract. **Flow:** 1. Read workflow source. 2. Match marker and request text. 3. Require the listen window.

### `test_every_call_capable_live_ci_gateway_disables_voicemail_detection`

**Proves:** All call-capable live workflows disable voicemail detection. **Flow:** 1. Discover workflows. 2. Inspect configuration. 3. Require the setting and inventory.

## Live — external events (escalation → agent calls driver)

Uses a real model and a locally served webhook route. These tests verify authenticated dispatch boundaries; they do not require the model to place a call.

### `test_signed_external_event_reaches_openclaw_dispatcher`

**Proves:** A correctly signed generic external event reaches the OpenClaw dispatcher as verified. **Flow:** 1. Sign and submit a unique event. 2. Require acceptance. 3. Match its dispatch marker.

### `test_forged_github_signature_is_rejected_before_dispatch`

**Proves:** A forged provider signature is rejected before dispatch. **Flow:** 1. Submit a realistic event with an invalid signature. 2. Require unauthorized status. 3. Require no dispatch marker.

### `test_valid_github_signature_reaches_openclaw_dispatcher`

**Proves:** A valid provider signature reaches the OpenClaw dispatcher as verified. **Flow:** 1. Sign a realistic event. 2. Require acceptance. 3. Match its dispatch marker.
