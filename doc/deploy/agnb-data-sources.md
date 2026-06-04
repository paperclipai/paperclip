# AGNB data sources — activation guide

The AGNB dashboards are fed by a built-in job scheduler (`server/src/agnb/scheduler.ts`
runs `server/src/agnb/jobs/registry.ts`). The jobs are already wired and most are
`enabledByDefault: true`; they **light up the dashboards once their API keys are set
in the Cloud Run env**. No code change is needed to "reconnect data" — set the keys.

Set env vars on the Cloud Run service (preserved across `--source` deploys):

```bash
gcloud run services update paperclip --region asia-south1 \
  --update-env-vars HUBSPOT_TOKEN=...,POSTHOG_PROJECT_ID=...,POSTHOG_PERSONAL_API_KEY=...,ROCKETSDR_API_KEY=...,GEMINI_API_KEY=...
```
> Prefer Secret Manager for keys: `--update-secrets HUBSPOT_TOKEN=hubspot-token:latest` etc.
> A job whose `requiresEnv` keys are missing is **skipped** (no error); set the key and it starts on its next tick.

## Key → what it lights up

| Env key | Jobs (cadence) | Dashboards fed |
|---|---|---|
| `HUBSPOT_TOKEN` | `hubspot-deals-sync` (hourly), `crm-hygiene-scan` (daily) | **Pipeline board + forecast**, CRM hygiene |
| `POSTHOG_PROJECT_ID` + `POSTHOG_PERSONAL_API_KEY` | `posthog-sync` (hourly) | Site funnel, traffic sources, top pages |
| `ROCKETSDR_API_KEY` | `rocket-personas`, `rocket-products` (12h), `inbox-sync` (30m), `preview-leads` | Personas, Products, Rocket inbox, preview leads |
| `GEMINI_API_KEY` | `gap-analyzer`, `backlink-prospector` (daily), `tag-replies` (hourly), `changelog-drafter`, `whatsapp-intake` | Content gaps, backlink prospects, reply tags, changelog drafts |
| _(none)_ | `rss-sync`, `sitemap-scraper`, `content-audit`, `backlink-health`, `link-strength`, `utm-hygiene-scan`, `gsc-rank-tracker`, `daily-brief`/`daily-digest`, `renewal-reminders` | RSS, competitor blogs, content audit, backlink health, SEO ranks, briefs/digests, renewals — run already |

Notes:
- `hubspot-deals-sync` was added to fill the Pipeline mirror (`agnb.hubspot_deals`); the
  standalone app read deals live, so without this job the board only had seed/agent data.
- `gsc-rank-tracker` (BoFu/SEO ranks) may need Google Search Console credentials wired
  separately — verify it has what it needs if BoFu ranks stay empty.
- External review sites (G2/Trustpilot/Capterra) bot-wall scrapers — see issue
  for the Reviews/Competitor/Backlink/BoFu **agents'** collection infra
  (separate from these server-side syncs).

## Verify a job after setting a key
- Open the **Producers** page (AGNB → ops) and the relevant dashboard.
- Trigger a one-off run: `POST /api/agnb/jobs/<key>/run` (board session), then re-check the dashboard.
- Or wait for the next tick (cadence above).
