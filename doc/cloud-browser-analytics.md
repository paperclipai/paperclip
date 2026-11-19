# Cloud Browser Product Analytics

On Paperclip Cloud, the board UI can send page views, sessions, autocapture
clicks, heatmaps, Web Vitals and session replays to PostHog. Self-hosted
installs never do this: they do not download `posthog-js` and do not serve the
PostHog proxy.

## Who gets it

The server decides, in `server/src/services/cloud-posthog-browser.ts`. The
authenticated `GET /api/auth/get-session` response carries a
`browserAnalytics` object only when all of these hold:

1. The instance is cloud managed (`isCloudManagedInstance`).
2. `PAPERCLIP_POSTHOG_PROJECT_TOKEN` and `PAPERCLIP_CLOUD_STACK_ID` are set.
3. `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`.

Otherwise the field is `null`, and the browser loads nothing. When it is set,
the browser loads PostHog's browser script (`/_ph/static/array.js`, through the
proxy) only after the page settles (first paint, page reads finished, browser
idle), so cold loads do not wait for it. posthog-js is not an npm dependency
of the board and is in no bundle chunk; PostHog serves it, as it serves the
extensions posthog-js loads at run time (recorder, web vitals).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_POSTHOG_PROJECT_TOKEN` | — | PostHog project token. It is public by design: it can send events but cannot read data. |
| `PAPERCLIP_POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest host. The proxy forwards to it. |
| `PAPERCLIP_POSTHOG_ENVIRONMENT` | — | `staging` or `production`. Added to every event as `environment`. |
| `PAPERCLIP_POSTHOG_BROWSER_ENABLED` | off | `1` turns browser analytics on for this stack. Leave it unset to keep it off. |
| `PAPERCLIP_POSTHOG_REPLAY_ENABLED` | on (when browser analytics is on) | `0` turns session replay off for this stack and keeps the other browser analytics. |
| `PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT` | `1024` | Proxy requests in flight for the whole server. See [Proxy limits](#proxy-limits). |
| `PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT` | `128` | Proxy requests in flight from one public client address. See [Proxy limits](#proxy-limits). |
| `PAPERCLIP_POSTHOG_COUNTRY_HEADER` | — | Name of a request header that the platform edge sets to the visitor's two-letter country code (for example `CF-IPCountry` behind a proxied Cloudflare zone). Leave it unset unless the edge sets the header and drops a value from the client. See [Consent](#consent). |

### Per-stack opt-out

For a customer whose contract forbids recording, set
`PAPERCLIP_POSTHOG_REPLAY_ENABLED=0` on that stack. To turn off all browser
analytics for a stack, unset `PAPERCLIP_POSTHOG_BROWSER_ENABLED`. Both take
effect on the next server restart.

## Consent

Visitors in the EU, the EEA, the UK and Switzerland must agree before browser
analytics and session replay start. Everyone else keeps analytics on by
default. Both can change the choice later. Server events are not affected:
they set no cookies.

### Who must agree

1. The server decides when it knows the visitor's country. If
   `PAPERCLIP_POSTHOG_COUNTRY_HEADER` names a header and the request carries a
   valid two-letter code in it, `browserAnalytics.consentRequired` is `true`
   for the EU and EEA countries (and their outermost regions and Svalbard), the
   UK (and the Crown Dependencies and Gibraltar) and Switzerland, and `false`
   for every other ISO 3166-1 alpha-2 country. The aliases `UK` and `EL` count
   as `GB` and `GR`, and `EU` and `EZ` count as consent required. Any other
   value (for example `XX`, `UN`, `XK` or `T1`) gives `null`.
2. Otherwise `consentRequired` is `null`, and the browser decides from its time
   zone. It asks when the zone starts with
   `Europe/`, is an EU, EEA or UK zone outside Europe (for example
   `Atlantic/Canary`, `Atlantic/Reykjavik`, `Asia/Nicosia`, `Indian/Reunion`),
   or is unknown (`UTC`, `Etc/*`, empty, or `Intl` fails). When unsure, it asks.

Both lists live in one place, `packages/shared/src/analytics-consent.ts`
(`countryRequiresAnalyticsConsent`, `timeZoneRequiresAnalyticsConsent`). The
browser's choice logic is in `ui/src/lib/analytics/consent.ts`.

Paperclip Cloud uses the time zone today. Requests reach Railway through
DNS-only Cloudflare records, so no Cloudflare country header arrives, and the
Railway edge adds no country header. Set `PAPERCLIP_POSTHOG_COUNTRY_HEADER`
only when an edge that sets and overwrites a country header is in front of
the stack. A visitor who forges the header can only change the default for
their own browser.

### What happens

| Visitor | Before a choice | Accept / switch on | Decline / switch off |
| --- | --- | --- | --- |
| Must agree, no Do Not Track or Global Privacy Control | Banner. posthog-js does not load: no `/_ph` requests, no PostHog cookies or storage. | posthog-js loads at once, without a reload. | Nothing loads. |
| Must agree, `navigator.doNotTrack === "1"` or `navigator.globalPrivacyControl === true` | No banner. Counts as Decline, also over a stored Accept. | Not possible: the settings switch is off and disabled, and says why. | Nothing loads. A running client opts out. |
| Everyone else | Loads after the page settles, as before. | — | `opt_out_capturing()` and `stopSessionRecording()` run at once. After the next load, posthog-js does not load. |

The gate calls one function, `syncProductAnalytics(config, consent)` in
`ui/src/lib/analytics/product-analytics.ts`. It starts, opts in, opts out or
cancels. Analytics stops whenever the choice is not `granted`, also when it goes back
to "ask" (another tab removes the stored choice, or a session refresh changes
`consentRequired` to `true`). If the choice changes while posthog-js is still
downloading, `init()` does not run until the choice is `granted` again.

The banner sits at the bottom of the page and does not block the board. It
says that recordings hide what the visitor types and their messages,
documents and connected accounts, but can show page names such as task
titles. It links to the privacy policy (https://paperclip.ing/privacy/).

### Where the choice is kept

The choice is per browser, in `localStorage` under
`paperclip.analyticsConsent` (`granted` or `denied`). The latest choice on
the page wins, also when storage rejects the write; it then lasts for the open
page only. Each user can change it in
**Settings → Profile → Product analytics**. The switch shows only when browser
analytics is on for the instance. Turning it on after an earlier opt-out also
clears the PostHog opt-out (`opt_in_capturing()`).

To reset the choice and see the banner again, remove the key in the browser
console: `localStorage.removeItem("paperclip.analyticsConsent")`, then reload.

## Reverse proxy

The browser sends to `/_ph` on its own origin, so ad blockers do not drop
events. `server/src/routes/posthog-proxy.ts` is not a generic proxy. It
forwards only the requests posthog-js makes:

| Method | Path | Upstream |
| --- | --- | --- |
| `POST` | `/e/`, `/i/v0/e/`, `/batch/` | ingest host |
| `POST` | `/s/` (session replay) | ingest host |
| `POST` | `/flags/`, `/decide/` | ingest host |
| `GET` | `/array/<token>/config`, `/array/<token>/config.js` | assets host |
| `GET` | `/static/<name>.js` | assets host |

The ingest host is `PAPERCLIP_POSTHOG_HOST`. The assets host is derived from it
(`us.i.posthog.com` → `us-assets.i.posthog.com`). Every other method or path
answers 404 without contacting PostHog. The proxy streams bodies, builds a new
header set from an allowlist plus `X-Forwarded-For`, and never forwards the
inbound Host, Cookie or Authorization headers. It drops `Set-Cookie` from
responses. It refuses bodies over 64 MiB (413) and limits the requests in
flight (429, see [Proxy limits](#proxy-limits)). It is mounted only when
browser analytics is on. It does not require a session: posthog-js sends some
events while a page unloads, and the proxy can only reach the two PostHog hosts
with the public project token, like PostHog's own ingest endpoint.

### Proxy limits

Each open tab runs posthog-js. One tab sends event batches, session replay
uploads and remote settings requests, so it can have a few requests in flight
at once, and more when PostHog is slow (the proxy waits up to 30 seconds for
an answer). The proxy has two limits. When a request is over a limit, the proxy
answers 429 with `Retry-After: 1`, and posthog-js sends it again later.

| Limit | Default | Variable |
| --- | --- | --- |
| Requests in flight for the whole server | 1024 | `PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT` |
| Requests in flight from one public client address | 128 | `PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT` |

Why these values:

- 128 per address covers about 10 people behind one office network, each with
  4 tabs and 3 requests in flight per tab, with space left over.
- 1024 in total keeps memory use bounded. The proxy streams bodies, so a
  request holds two sockets and the stream buffers between them, not the full
  body. In a local test, 1024 held requests added about 96 MiB of resident
  memory with 4 KiB bodies and about 173 MiB with 256 KiB bodies. These
  numbers include the test client and the test upstream, which ran in the same
  process. Most PostHog bodies are a few KiB.

A value must be a whole number from 1 to 65536 (for example `2048`). The
server reads the values at start. If a value is not valid, the server logs a
warning, uses the default, and starts as usual.

Each request has a deadline of 60 seconds from the time the proxy accepts it,
whether or not data still moves. At the deadline, the proxy stops the request
to PostHog and closes the browser request, so a slow body or a slow answer
cannot hold a slot for longer. This deadline is not configurable. The proxy
also stops a request to PostHog that has no data for 30 seconds.

#### Shared platform hop

The per-client limit uses `req.ip`, which comes from the server's trusted proxy
settings (`TRUST_PROXY`). It never comes from a header the client controls. If
`TRUST_PROXY` is unset behind a platform proxy, `req.ip` is the proxy's private
hop (for example `100.64.x.x` on Railway). All visitors come from that one
address, so a per-client limit would hold back all of them together.

When `req.ip` is not a public address (private, carrier-grade NAT, loopback,
link-local or another reserved range, or no address), the proxy applies only
the total limit. A separate limit for the shared hop would not protect the
visitors behind it: one client that fills it blocks all of them, the same as
with the total limit. The total limit and the request deadline bound the
memory and sockets that clients can use. It does not read `X-Forwarded-For` to find the visitor for a
limit, because a client can write that header. Set `TRUST_PROXY` to the
platform's proxy range so that `req.ip` is the visitor, and the per-client
limit applies again.

#### When the limits are hit

When the proxy refuses a request at a limit, it logs the warning
`PostHog proxy refused requests at its in-flight limit` at most once a minute.
The warning has these fields, and no addresses or other visitor data:

- `refusedAtTotalLimit` and `refusedAtPerClientLimit`: the requests refused
  at each limit since the last warning (the first warning counts only one).
- `inFlight`: the requests in flight when the warning was written.
- `maxInFlight` and `maxInFlightPerClient`: the limits in use.
- `sinceMs`: the time since the last warning, or `null` for the first one.

#### Tuning a fleet

Set the variables with a fleet `env_config` campaign, the same way as the
other `PAPERCLIP_POSTHOG_*` variables. Start with a canary stack. The server
reads the values at start, so a campaign that drains and restarts the stacks
applies them at once, and a campaign with `"applyOnNextDeploy": true` applies
them on the next deploy. To go back to the defaults, remove the variables.

Raise `PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT` when the warning shows refusals
at the total limit and the stack has memory to spare. Raise
`PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT` when it shows refusals at
the per-client limit, for example for a customer with many people behind one
address.

### Visitor location

The `X-Forwarded-For` value that the proxy sends to PostHog carries the
visitor's location. When the socket peer is private, the proxy uses the
rightmost public `X-Forwarded-For` entry, which the platform edge appended.
This value is used only for location, never for limits.

## Identity

- After sign-in: `identify(session.userId, { email, name })`. `session.userId`
  is the authenticated actor's user id verbatim (`req.actor.userId`, for
  example `paperclip-id:...`), the same id server events use as `distinct_id`. Email and name are person
  properties only, never event properties.
- `group("workspace", stackId)`.
- Every event carries `deployment_source: "cloud"` and `environment`. Without
  `PAPERCLIP_POSTHOG_ENVIRONMENT`, `environment` is `staging` on a
  `*.staging.paperclip.app` host and `production` otherwise.
- Sign-out: `reset()`, called by `useSignOut` before it leaves the page.
- API requests to our own host carry PostHog tracing headers, so server events
  link to the browser session.

## Onboarding events

The in-workspace onboarding wizard (`ui/src/components/OnboardingWizard.tsx`)
captures four browser events through `ui/src/lib/analytics/onboarding-analytics.ts`.
They follow the same consent rules as every other browser event: without a
browser analytics config or with consent not granted, nothing is captured.
Events from before posthog-js loads wait in a short queue (at most 50) and keep
their original time. Withdrawing consent or a change of signed-in person drops
the queue.

| Event | When | Properties |
| --- | --- | --- |
| `onboarding_opened` | The wizard opens, once per open. Auto-open (`useAgentlessOnboardingAutoOpen`), a button, and the `/onboarding` route all count. | `step` when the wizard opens on an agent step |
| `onboarding_step_viewed` | A step is shown, once per step change. | `step` |
| `onboarding_step_completed` | The customer moves forward one step, presses Launch on the review step, or Launch finishes. | `step`; `outcome` for `connect_model` (`subscription` or `api_key`) and for `launch` (`succeeded` or `failed`) |
| `onboarding_dismissed` | The wizard closes before Launch finishes, for example when the customer leaves the onboarding page. | `step` when closed on an agent step |

`step` is one of `create_agent`, `connect_model`, `review`, or `launch`. The
organization-naming steps have no `step` value. No event carries free text.

## Privacy

Session replay shows text by default, the way PostHog normally works. Text is
masked only inside marked customer content. Input values and attribute values
are always masked.

- Session replay masks every input value (`maskAllInputs`).
- Replay masks text only inside these markers (`ANALYTICS_MASK_TEXT_SELECTOR`
  in `ui/src/lib/analytics/privacy.ts`, passed as rrweb `maskTextSelector`):
  - `ANALYTICS_MASK_CLASS` (`ph-mask ph-sensitive`): customer content.
  - `ANALYTICS_NO_CAPTURE_CLASS` (`ph-no-capture`): secrets. Replay blocks
    these elements entirely.
  - `contenteditable` editors (not `contenteditable="false"`).

  rrweb masks a text node only when its parent matches the selector or has an
  ancestor that matches it. All other text, for example navigation, headings,
  buttons, task titles, agent names, project names and company names, is
  recorded as it is.
- Replay also masks attribute values (`maskReplayAttribute`): only layout
  attributes (`class`, `style`, `role`, `data-state`, SVG geometry and similar),
  rrweb metadata and stylesheet links keep their values. `title`,
  `aria-label`, `alt`, `placeholder`, `src`, `href`, `data-*` values and
  element references (`id`, `for`, `aria-labelledby`) are always masked, so
  images record as empty boxes and link targets (for example download links
  with file paths) never leave.
- The masking options in `posthog.init` take precedence over the PostHog
  project's "Privacy and masking" settings (posthog-js 1.450). posthog-js
  ignores the project setting and logs a warning when the two differ. Keep the
  project masking settings empty, and change masking only in `privacy.ts`. The
  `ph-mask` class is also the posthog-js default `maskTextClass`.
- `ANALYTICS_NO_CAPTURE_CLASS` replaces secrets with a blank box in replays:
  every password-type `Input`, environment variable values, new secret
  values, and secrets shown as text: one-time sign-in and device codes,
  pairing and setup prompts, identity confirmation links, newly issued API
  keys and gateway tokens, gateway client snippets, webhook URLs and secrets,
  invite claim secrets, raw provider frames and SSH fallback commands.
- Every event and replay meta event goes through `scrubCapturedEvent`
  (`before_send`). Every URL keeps only its origin and path: query and hash
  values never leave, because they can hold credentials, file paths or search
  text. The token segment of `/board-claim/<token>` and `/invite/<token>` is
  redacted (`redactAnalyticsUrl`). Other strings only have secret
  `key=value` pairs redacted.
- Events never carry the page title (`before_send` drops `title`), because
  Paperclip page titles name the task and the organization.
- Autocapture never records element text or attribute values
  (`mask_all_text`, `mask_all_element_attributes`). It keeps the click, the
  element tree and the page.
- Connected-account content is Google user data or Slack data. No human may
  read it in a replay (privacy policy and Google API Limited Use). The
  surfaces below, and other free-form text that agents or customers write,
  carry `ANALYTICS_MASK_CLASS` on their content element (not on the chrome
  around it):
  - Rendered markdown (task bodies, comments, chat messages, documents), the
    rich editor, task and issue chat threads (messages, tool calls, tool
    results, interaction cards), the comment timeline and the file viewer.
  - Link preview cards, task quicklook descriptions, external object pills and
    rows, and related-work titles.
  - Email message cards and email send intents.
  - Connection names, connected account names, aliases and email addresses
    (Browse rows and the remove dialog, Connections, app detail headers, the
    app sidebar, connection choice lists and instructions, aggregator and
    Composio account dialogs, Tailscale networks, agent tool and audit
    tables, AI connection names, pickers, selects, account details and
    controls, pool run details, subscription and quota panels, adapter
    sign-in status, connection access and repair cards), GitHub logins
    (identity rows, bot people, chat setup, run identity history) and
    repositories, Slack workspace names (list and selected value), Slack
    account pickers, chat channels, linked user labels, the external task
    banner and chat identity pages.
  - Connection and account management surfaces are masked by section, not
    label by label: the Browse connector list, the App detail body below its
    header, the Connections table, Tailscale networks, the chat connection
    detail body and its account subtitle, GitHub chat setup, the AI
    connection pool editor and the chat identity confirmation. Every dialog,
    alert dialog, select (trigger and list), popover, dropdown, sheet and
    tooltip under `pages/apps`, `features/connections` and
    `components/ai-connections` carries its own mask, because portals escape
    the page's masked container; `replay-masking.test.tsx` fails when one
    does not.
  - App action test results (parsed preview and raw response).
  - Inbox and decision rows (subject and detail line), obligation evidence,
    Needs You notes and receipts, decision cards and compact decisions,
    decision records, and interaction cards (questions, options, answers,
    tool action requests, suggested tasks) wherever they render.
  - Approval payloads, action card input and reason, recovery card headline,
    evidence and options, run ledger retry details and interrupt handoff
    previews.
  - Run transcripts, run failure details, run events, run stdout and stderr
    excerpts (agent page and execution workspace operations), the run
    invocation command, notes, prompt, context and environment, Runner
    inspector frames, and every preformatted block that shows run output,
    tool or webhook payloads, request or response bodies, instructions,
    skills or package files.
  - Saved connection instructions for agents.
  - Document and case revision diffs.
  - Search result snippets, toasts (title and body), voice and call
    transcripts, case summaries, files and fields, attachment previews and
    artifact previews (text, tables, patches and documents).

  Component tests render these surfaces with distinctive fixture text and
  assert, through `ui/src/lib/analytics/replay-recording.test-utils.ts`, that
  the text is rendered but not recorded (or is blocked, for secrets),
  including alternate branches, dialog portals and selected values in
  closed pickers. `ui/src/lib/analytics/replay-masking.test.tsx` also pins
  the remaining surfaces at source level. A new surface that shows
  connected-account content needs the class and a test.
- Residual risk: text that the owner accepted as visible can still hold
  customer words. Task titles, agent names, project names, company names,
  routine names, artifact and document titles, and activity rows (which name
  the task or entity) are recorded as they are. Paperclip member names and
  email addresses on member, access and profile pages are recorded too. An
  agent can copy email or Slack text into a task title. Masking is opt-in per
  surface, so a new surface that renders connected-account content without
  the class is recorded until somebody marks it.
- The UI never captures an event that the server already sends
  (`PAPERCLIP_EVENTS`); `product-analytics-events.test.ts` enforces this.
