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

### Per-stack opt-out

For a customer whose contract forbids recording, set
`PAPERCLIP_POSTHOG_REPLAY_ENABLED=0` on that stack. To turn off all browser
analytics for a stack, unset `PAPERCLIP_POSTHOG_BROWSER_ENABLED`. Both take
effect on the next server restart.

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
responses. It refuses bodies over 64 MiB (413) and limits requests in
flight to 16 per client address and 256 in total (429). It is mounted only when
browser analytics is on. It does not require a session: posthog-js sends some
events while a page unloads, and the proxy can only reach the two PostHog hosts
with the public project token, like PostHog's own ingest endpoint.

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

## Privacy

Masking is deny by default. A surface that nobody marked stays masked.

- Session replay masks every input value and every text node.
  `maskReplayText` in `ui/src/lib/analytics/privacy.ts` shows text only inside
  elements with `ANALYTICS_UNMASK_PROPS`: sidebar items whose label is a fixed
  string, and a shared `Button`, `Label`, `TabsTrigger` or `EmptyState` only
  when its caller passes `analyticsChrome`. None of them opts in by default,
  because they also render customer text such as agent names and titles.
- Replay also masks attribute values (`maskReplayAttribute`): only layout
  attributes (`class`, `style`, `role`, `data-state`, SVG geometry and similar),
  rrweb metadata and stylesheet links keep their values. `title`,
  `aria-label`, `alt`, `placeholder`, `src`, `href`, `data-*` values and
  element references (`id`, `for`, `aria-labelledby`) are always masked, even on unmasked chrome, so images record as empty boxes and
  link targets (for example download links with file paths) never leave.
- `ANALYTICS_MASK_CLASS` keeps customer content masked even inside unmasked
  chrome: rendered markdown (task bodies, comments, chat messages, documents),
  task and issue chat threads, the comment timeline, the rich editor and the
  file viewer. Text in a `contenteditable` editor is always masked.
- `ANALYTICS_NO_CAPTURE_CLASS` replaces secrets with a blank box in replays:
  every password-type `Input`, environment variable values and new secret
  values.
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
- Connected-account content (Gmail bodies, Calendar events, Slack messages
  in tasks, chat, tool results and previews) is Google user data or Slack
  data. No human may read it in a replay (Google API Limited Use). It is never
  inside the unmask allowlist, and autocapture records no element text at all.
  `ui/src/lib/analytics/unmask-allowlist.test.ts` pins the allowlist: a new
  unmask needs a reviewed entry there.
- The UI never captures an event that the server already sends
  (`PAPERCLIP_EVENTS`); `product-analytics-events.test.ts` enforces this.
