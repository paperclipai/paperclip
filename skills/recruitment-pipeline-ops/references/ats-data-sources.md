# ATS Data-Source Cheat Sheet (local mirror)

> Canonical source of truth: `~/TSKB/KB/TSKB0489 [TSR] - Verified ATS Data-Source Cheat Sheet - v1.0 - 08-26.md`.
> **Update the canonical file first** (append-only — cite the discovering issue), then re-sync this mirror.
> This copy exists so a research-phase run can check it without a separate TSKB lookup.

## Verified sources (confirmed working in an actual TSR card)

| ATS platform | Use this (confirmed working) | Don't waste turns on |
|---|---|---|
| **Ashby** | `https://api.ashbyhq.com/posting-api/job-board/{org-slug}` — public JSON, no auth. Human apply URL: `https://jobs.ashbyhq.com/{org-slug}/{posting-uuid}`. | Company's own `/careers` page (bot-blocked). |
| **Greenhouse** | `https://boards-api.greenhouse.io/v1/boards/{org-slug}/jobs?content=true` — public JSON feed (same data `job-boards.greenhouse.io/{org-slug}` renders from). | Employer's own careers page (Cloudflare 403). An embedded `gh_jid` job-detail URL on the employer's own domain can be browser-fetchable (HTTP 200) even when a plain `curl` of the identical URL 403s moments later — treat plain-fetch 403 on a `gh_jid` URL as inconclusive, not dead. |
| **BambooHR** | Detect via `data-domain="*.bamboohr.com"` or `bamboohr.com/js/embed.js` in a plain GET of the employer's `/careers` page, then query `https://<that-domain>/careers/list` (public JSON, no auth). | Aggregator/syndication mirrors (Indeed, ZipRecruiter, GrabJobs, Glassdoor) — proven unstable, fetchable one pass and 403 the next for the same URL. |
| **Workday** | `https://<company>.wd{N}.myworkdayjobs.com/<career-site-name>` — confirm the shard number/site name once per employer (follow the link from their public careers page), then reuse. | Guessing the shard/slug without confirming once. |
| **publicjobs.ie / Irish public-sector (`tal.net`)** | Plain GET works, HTTP 200 with access-proof canaries — no bot-blocking observed on this family. | N/A |

## Known patterns (not yet confirmed inside a TSR card — try, then promote with a citation)

| ATS platform | Try this first |
|---|---|
| **Lever** | `https://api.lever.co/v0/postings/{org}?mode=json` |
| **Workable** | `https://apply.workable.com/api/v1/widget/accounts/{slug}` |
| **Personio** | `<company>.jobs.personio.de` (iframe embed target in employer page source); also `personio.de/xml` feed |

## Known-blocked (don't retry, go straight to the table above)

- Company-direct marketing career pages: `openai.com/careers`, `cubic3.com/careers`, `rubrik.com/careers` (root), `x.ai/careers/open-roles`.
- Aggregator/syndication mirrors as a liveness source of record (use only as a labelled freshness probe, never as evidence on their own).
- `ie.indeed.com` and other Indeed country domains: consistent 401/403/Cloudflare-challenge.

## Full detail and evidence citations

See `TSKB0489` for the per-row issue citations (TSR-5833 Cubic3, TSR-5834 Rubrik, TSR-5836 xAI, TSR-5837 Medserv) and the append-only update procedure.
