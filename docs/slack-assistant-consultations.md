# External assistant consultations over the existing Slack integration

This feature reuses Munder's signed Slack callback and bot token. It does not
create another Slack app, change the request URL or relax the ordinary bot-message
filter. Questions are explicit outbound actions to one configured destination.

For a Portuguese walkthrough of the exploratory-QA workflow and colleague setup,
see [QA: consulta ao maestro e replicação](qa-maestro-setup.pt-BR.md).

## Setup

1. Build/restart Munder to load the updated main process and helper. Preserve any
   running agent work before restarting. `npm run build` builds; it does not restart
   an already running app or replace a separately installed packaged binary.
2. In Settings → Connections → Slack, keep the existing signing secret/token and
   enable **External assistant consultations**. This opt-in is independent of the
   proactive acknowledgement toggle, which stays unchanged.
3. Configure channel ID, mention ID, trusted responder ID and response deadline.
   No workspace-specific IDs are compiled into the application.
   - U…/W… mentions use `<@ID>`; responder defaults to the same ID.
   - S… is a user-group mention and uses `<!subteam^ID>`. It requires the actual
     responder's U…/W… user ID, B… bot ID or A… app ID. Group membership alone
     never authorizes a response.
4. Select the conversation mode:
   - **Mention and question together:** post one root message containing both.
   - **Mention, greeting, question:** post the mention, wait for a case-insensitive match containing the configured
     greeting from the trusted responder, then send the question once in that thread.
     The greeting is not delivered as an ERP answer. A send interruption is not retried.
5. Invite both apps into the channel. Ensure the recipient assistant accepts
   bot-originated input. Subscribe the existing app to `message.channels` for a public
   channel or `message.groups` for a private one, with the corresponding history scope;
   `app_mention` alone is insufficient for unmentioned threaded replies. `chat:write`
   is required to send. Identity lookup permissions are optional if IDs are known.
6. Save. Consultation settings are read dynamically; changing the existing callback
   port/channel/signing-secret setup may require restarting the Slack connection as usual.

IDs and the greeting live in the user's `config.json` under `slackConsultation`.
The default is disabled with no channel or responder. Never commit bot tokens,
signing secrets, the discovery capability file or the consultation ledger.

## Calling from a standalone OpenCode orchestrator

The companion ERP project also registers a native `md_slack_consult` tool through
its `project-tools.ts` plugin. This adapter is not installed by Munder's build and
is not an MCP server. It supports `probe`, `ask`, `status`, and
`retry_notifications`; the last two take `consultationId`. `probe` performs an
authenticated local read without posting to Slack, not an end-to-end assistant
check. `ask` takes `question`/`context` and resolves the current and parent session
from the host; use an actual `orchestratorSessionID` override when the orchestrator
is not the direct parent. See the Portuguese guide for files and replication.
The consultation is ERP guidance even when no acceptance criterion tests Slack.

From this repository (or use the helper's absolute installed path):

```sh
node resources/md-slack-consult.cjs \
  --question "What prerequisites and UI steps are required for this flow?" \
  --context "QA / ticket / scenario" \
  --orchestrator-session ses_ActualOrchestrator \
  --requester-session ses_ActualExecutor \
  --directory /absolute/project/root
```

Use actual session IDs from the execution, not labels or fabricated IDs. The helper
supports `--orchestrator-directory` and `--requester-directory` if the sessions are
in different projects; otherwise both use `--directory` (the current directory by default).
The helper
prints a recovery ID before sending and returns a local consultation record. Munder
then admits updates to each session's OpenCode V2 inbox using the authenticated
`opencode api post /api/session/{id}/prompt` CLI with `delivery: steer`. This is a
real inbox input and may resume an idle session. The CLI must be installed and on
Munder's PATH; session delivery failures remain visible, never silently reported as
success. An admitted input is not proof that the agent already read or acted on it.

In a Hive, use `--orchestrator-agent god --requester-agent <worker-id>` instead.
Updates use normal Hive inbox routing, not new Slack-origin tasks. These recipients
must exist and be active. No default external OpenCode session is guessed.

The helper discovers the capability-protected loopback server through
`MD_SLACK_REPLY_CONFIG`, `--config <file>`, or the conventional Munder userData
location. An unavailable broker is an error, not a reason to read Slack credentials.
It also supports stdio MCP (`--mcp`): `consult`, `status`, `retry_notifications`.
Registering this server in an external host remains an explicit host setup step.

## Recovery and lifecycle

```sh
node resources/md-slack-consult.cjs --status <consultation-id>
node resources/md-slack-consult.cjs --retry-notifications <consultation-id>
```

- `sending` → `waiting` → `received`, `timed_out`, `failed` or `delivery_unknown`.
- Sender + channel + thread must match. Callback signatures are verified before
  correlation. Replies to unknown threads and other bots remain ineligible.
- Repeated callbacks are deduplicated; additional response messages update both
  recipients. `received` is not a semantic completion signal. Only the configured
  greeting is excluded; other processing messages are not guessed away.
- Three attempts per notification batch, then an explicit retry is required.
  Notification retries do not resend Slack messages. Stable event IDs are used
  for OpenCode admission; transport ambiguity can still require inspection.
- Reusing a consultation ID with the same request does not repost. A changed
  request with that ID is rejected. Unknown delivery must be checked in Slack.
- Late replies remain correlated after timeout. The full deadline includes the
  greeting in two-step mode. There is no automatic repost on timeout.
- Local ledger: `slack-consultations.json` in userData, atomically replaced with
  owner-only permissions. It includes questions/replies and recipient IDs, not Slack
  credentials. Keep questions free of secrets. Completed delivered records may be
  evicted at capacity; retention is bounded to 24 hours and 200 records.
- A restart restores pending deadlines and unconfirmed updates. An interrupted
  root or follow-up send becomes `delivery_unknown`, never an automatic duplicate.
  Munder must be running and its public Slack callback reachable to receive events.

## Verification

```sh
npm run typecheck
node --test test/slack-consultations.test.cjs test/slack-consult-network.test.cjs
```

The tests execute the real local broker, signed callback, CLI/MCP helper, correlation
and notification adapters. A local HTTP Slack stand-in exercises actual request/
response/error handling with a test-only transport redirect; it does not verify
Slack TLS, workspace membership, event subscriptions or assistant behavior. The
OpenCode adapter test launches a CLI stand-in, not a real model session. No test
posts to a real Slack workspace. Live validation is a separate explicit action.
