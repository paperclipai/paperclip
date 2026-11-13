# Browser Performance Tracing

The board UI can send real-user page-load measurements, Core Web Vitals, and
API request spans to Honeycomb (or any OTLP/HTTP collector). The data answers
questions such as "what is the P95 time to load the all-tasks page?" and can
back a Honeycomb SLO with an owner.

This is part of the operator-gated Observability path (see
[observability.md](observability.md) and `rules/data-paths.mdc`). It is not the
first-party Telemetry system and adds no Telemetry events.

## Who gets it

Browser tracing runs **only on hosted Paperclip Cloud instances** that an
operator explicitly configures. It is off by default.

The server decides, in `server/src/browser-tracing-config.ts`. It sends a
`browserTracing` object in the authenticated `GET /api/auth/get-session`
response only when both hold:

1. The instance is cloud managed (`isCloudManagedInstance`: a
   `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` or a `PAPERCLIP_MANAGED_CONFIG`
   document is present).
2. `PAPERCLIP_BROWSER_TRACES_ENDPOINT` is set and every setting is valid.

Otherwise the field is `null`. Self-hosted installs, local development, and
tests never satisfy (1). With `null`, or with no session (signed out), the
browser never downloads the tracing code: it lives in its own lazily loaded
chunk (`ui/src/lib/browser-tracing/sdk.ts`). An invalid setting fails closed:
the field is `null` and the server logs one warning naming the variable, never
its value.

## Configuration

Set these on the hosted server process:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PAPERCLIP_BROWSER_TRACES_ENDPOINT` | yes | — | OTLP/HTTP base URL, for example `https://api.honeycomb.io` (US) or `https://api.eu1.honeycomb.io` (EU). `/v1/traces` is appended unless the path already ends with it. Must be `https` (plain `http` only for a loopback host). |
| `PAPERCLIP_BROWSER_TRACES_INGEST_KEY` | for Honeycomb | — | A Honeycomb **ingest** key (prefix `hcaik_`). Sent as `x-honeycomb-team`. Required when the endpoint is a Honeycomb host; optional for a collector you run. Any other key format is refused. |
| `PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE` | no | `1` | Fraction of page sessions traced, `0`–`1`, rounded to an exact 1 in N (`0.3` becomes 1/3; `0.75` becomes 1). `0` turns tracing off. |
| `PAPERCLIP_BROWSER_TRACES_SERVICE_NAME` | no | `paperclip-web` | `service.name`; in Honeycomb this is the dataset name. |
| `PAPERCLIP_BROWSER_TRACES_ENVIRONMENT` | no | `SENTRY_ENVIRONMENT` | `deployment.environment.name`, for example `staging`. |

### Key handling

Every signed-in browser can read the key, the same way it can read the
front-end Sentry DSN. That is why only a Honeycomb **ingest** key is accepted:
it can send events but cannot read data or change the Honeycomb account. Use a
key scoped to the environment that should receive browser data, keep it in the
hosting secret store, and never commit it. To keep the key out of browsers
entirely, point the endpoint at an OTLP collector you run (it adds the key) and
leave `PAPERCLIP_BROWSER_TRACES_INGEST_KEY` unset. That collector must allow
CORS `POST` from the instance origin with the `content-type` header.

### Sampling

The sample decision is made once per page session (one tab load), before the
SDK downloads. An unsampled session downloads and sends nothing. A sampled
session sends everything, so each trace is complete. When the rate is below 1,
every span carries Honeycomb's `SampleRate` attribute (1 in N, for example `4`
for `0.25`), so Honeycomb's `COUNT` and percentiles are weighted correctly.

Volume per sampled session: one `page.load` span per navigation, up to three
`web_vital.*` spans per page lifetime, and one span per same-origin `/api/`
request made after the SDK loads.

## Load-speed cost

Nothing loads on the critical path. The main bundle carries only the
measurement code (route matching, readiness checks); on the `ui` build of this
change the initial JavaScript grew by about 6.8 KB raw / 2.6 KB gzip (0.2%). The
OpenTelemetry SDK, a small OTLP JSON exporter, fetch instrumentation, and
`web-vitals` are a separate chunk (about 84 KB raw / 27 KB gzip) fetched only when tracing is on
and the session is sampled, and only after the page settles (painted, no query
fetching, browser idle; `ui/src/lib/when-page-settles.ts`). If the page never
settles (for example a request hangs), the chunk loads 35 seconds after tracing
starts anyway, so a hard load that ended as `timeout` is still exported.

Because the SDK loads after the first page settles, API requests made during
the hard load have no fetch spans. The hard load's `page.load` span is still
recorded: measurements taken before the SDK loads are buffered and exported
when it arrives.

## What "loaded" means

Each navigation produces one `page.load` span. It ends at the first animation
frame, held for two consecutive frames, in which:

1. no full-page loading state is mounted (the `PaperclipLoading` spinner, which
   is also the route `Suspense` fallback), and
2. one of:
   - **Content signal** (`ready_signal = content`): when the page declared a
     primary-content signal with `usePageContentReady`, every declared signal
     is ready. The end time is the paint time the page reported.
   - **Idle signal** (`ready_signal = idle`): otherwise, no React Query query
     that has no data yet is fetching. Background refetches of data already on
     screen do not count. The end time is the first such frame.

The rule lives in one place (`ui/src/lib/browser-tracing/page-load-recorder.ts`)
and the route comes from the router's own route tree (`App.tsx` passes the tree
it renders to `PageLoadTracker`), so a new page is measured without page code.

- **Hard load** (`load_type = hard`): starts at navigation start (the
  document request, time 0) and includes HTML, JavaScript download and start
  up, authentication, and the page's data and render. Redirects during the load
  (for example `/` to `/:companyPrefix/dashboard`) keep the same span, reported
  under the final route.
- **Client navigation** (`load_type = client`): starts when the URL path
  changes in history (a link click, `navigate()`, or back/forward) and includes
  lazy route code download, data loading, and render. Query-string and hash
  changes are not navigations. A history replace while a navigation is still
  open is a redirect and continues it.

Outcomes: `ready`; `interrupted` (another navigation started first); `timeout`
(not ready after 30 seconds). A navigation open when the tab closes is not
sent. `was_hidden = true` means the tab was hidden during the measurement;
browsers pause rendering in hidden tabs, so exclude these from SLOs.

Pages with an explicit content signal:

| Page | Route | Loaded when |
| --- | --- | --- |
| Task (issue) page | `/:companyPrefix/issues/:issueId` | The conversation content has painted: the same point as the `issue-detail:navigate→content-paint` User Timing measure. |
| All-tasks list (plain task list) | `/:companyPrefix/issues` | The first page of task rows has rendered (or the list shows its error state). The combined inbox and coordinator task views use the idle signal. |

An agent chat with no saved task has no content signal and uses the idle rule.

To add one, call `usePageContentReady(ready)` in the page component. Use it
only when the idle rule is inaccurate for that page.

## Emitted spans

All spans pass through an allowlist (`ui/src/lib/browser-tracing/span-sanitizer.ts`)
before export. Any other attribute an instrumentation adds, including full
URLs, server addresses, status messages, and event attributes, is dropped.

| Span name | When |
| --- | --- |
| `page.load` | One per hard load or client navigation. |
| `web_vital.lcp`, `web_vital.inp`, `web_vital.cls` | Core Web Vitals, from Google's `web-vitals`, usually reported as the tab hides. Zero duration; the value is an attribute. |
| `GET`, `POST`, … | A `fetch` to this origin's `/api/`. Its `traceparent` header joins the server's request span to the same trace. While a `page.load` span is open it is the parent, so one trace shows the navigation, its API calls, and (when server tracing is on) their server spans. |

Attributes (the complete allowlist):

| Attribute | On | Values |
| --- | --- | --- |
| `paperclip.page.route` | all | Route pattern, for example `/:companyPrefix/issues/:issueId`; `(unmatched)` when no route matches. Built only from route definitions, never from the URL. On fetch spans: the route current when the request started. On `web_vital.lcp`: the hard load's route. |
| `paperclip.page.load_type` | `page.load` | `hard`, `client` |
| `paperclip.page.outcome` | `page.load` | `ready`, `interrupted`, `timeout` |
| `paperclip.page.ready_signal` | `page.load` | `content`, `idle`, `none` |
| `paperclip.page.was_hidden` | `page.load` | boolean |
| `paperclip.page.navigation_type` | hard `page.load` | `navigate`, `reload`, `back_forward`, `prerender` |
| `paperclip.page.ttfb_ms`, `paperclip.page.dom_content_loaded_ms`, `paperclip.page.load_event_ms` | hard `page.load` | Navigation Timing milestones, ms from navigation start |
| `paperclip.web_vital.name` | `web_vital.*` | `LCP`, `INP`, `CLS` |
| `paperclip.web_vital.value` | `web_vital.*` | ms for LCP and INP; unitless for CLS |
| `paperclip.web_vital.rating` | `web_vital.*` | `good`, `needs-improvement`, `poor` |
| `paperclip.api.area` | fetch | First path segment after `/api/` when it is a fixed word (`issues`, `companies`, …), else `other`. Use the joined server span's route for detail. |
| `http.request.method`, `http.response.status_code`, `error.type` | fetch | OpenTelemetry HTTP semantics |
| `SampleRate` | all, when sampling | 1-in-N weight |

Resource: `service.name`, `service.version` (the UI build commit),
`deployment.environment.name`.

Not sent: URLs, paths with ids, query strings, hashes, referrers, user agent,
user, company, or task identifiers, titles, or content. Server spans carry no
company identifier, so browser spans do not either. Uncaught browser errors are
not sent here because Sentry already reports them
([observability.md](observability.md#sentry-error-monitoring)).

Trace headers go only to this origin (`propagateTraceHeaderCorsUrls` is empty),
so no third party receives a `traceparent`. Same-origin requests need no CORS
change. The server's OpenTelemetry HTTP instrumentation continues the trace
when server tracing is enabled ([observability.md](observability.md#enabling-tracing)).

## Example Honeycomb queries

Use the `paperclip-web` dataset (or your `service.name`) and the environment
that holds browser data. Exclude hidden tabs and unfinished loads.

**P95 load time of the all-tasks page**

```text
VISUALIZE  P95(duration_ms), COUNT
WHERE      name = page.load
           paperclip.page.route = /:companyPrefix/issues
           paperclip.page.outcome = ready
           paperclip.page.was_hidden = false
GROUP BY   paperclip.page.load_type
```

**P95 load time of an individual task page**

```text
VISUALIZE  P95(duration_ms), COUNT
WHERE      name = page.load
           paperclip.page.route = /:companyPrefix/issues/:issueId
           paperclip.page.outcome = ready
           paperclip.page.was_hidden = false
GROUP BY   paperclip.page.load_type
```

Group by `service.version` to compare builds. For a timeout rate, count
`paperclip.page.outcome = timeout` against all `page.load` spans for the route.
For Web Vitals, `P75(paperclip.web_vital.value)` where
`name = web_vital.lcp` (or `inp`, `cls`), grouped by `paperclip.page.route`.

**SLO.** A Honeycomb SLO needs a boolean SLI as a derived column. For example,
"task page loads within 2 s":

```text
IF(AND(EQUALS($name, "page.load"),
       EQUALS($paperclip.page.route, "/:companyPrefix/issues/:issueId"),
       EQUALS($paperclip.page.was_hidden, false)),
   AND(EQUALS($paperclip.page.outcome, "ready"), LTE($duration_ms, 2000)))
```

The expression is null for other events, so they do not count.

## Verifying a deployment

1. Set the variables above and deploy. A cloud-managed instance logs nothing on
   success; an invalid setting logs one `browser tracing is off` warning.
2. Sign in, open the browser network panel, and confirm the session response
   carries `browserTracing`, a `sdk-*.js` chunk loads after the page settles,
   and a `POST` to `…/v1/traces` returns 200.
3. In Honeycomb, query `name = page.load` in the browser dataset for the last
   10 minutes and check `paperclip.page.route` and `service.version`.
