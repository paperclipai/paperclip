---
title: Integrations
summary: Connectors that self-activate on key presence
---

AGNB drops in alongside your existing stack. There's no per-tool setup wizard: paste a key as an encrypted secret and the matching jobs come alive on their next cycle.

## Activation model

```
HUBSPOT_TOKEN=...        ->  pipeline-sync, hubspot-deals-sync, crm-hygiene-scan
GSC_PROPERTY=...         ->  gsc-rank-tracker, content-gap signals
SERPAPI_KEY=...          ->  reviews-sync, share-of-voice
POSTHOG_PROJECT_ID=...   ->  posthog-sync (funnel + traffic)
```

## Connectors

| Connector | Category | What it powers |
| --- | --- | --- |
| HubSpot | CRM | Deal sync, pipeline board, hygiene scans |
| Google Search Console | SEO | Rank tracking, content gaps |
| PostHog | Analytics | Funnel, traffic sources |
| SerpAPI | SEO | Review ratings, SERP share-of-voice |
| Slack | Comms | Alerts + HQ notification feed |
| LinkedIn | Outbound | Multi-sender + post scheduling |
| RocketSDR | Outbound | Lead sourcing, inbox sync |

## Models & local runtimes

Agents run on Claude, Gemini, or OpenAI — or local adapters (Codex, Grok, OpenCode) so no data leaves your environment. Secrets are encrypted and never exposed to agents in the clear.
