---
title: North Star
summary: The KPIs the company steers by
---

The North Star is one aggregate of the metrics that matter, on a single screen. It's the scoreboard the CEO's daily exec review reads.

## What it tracks

- **Pipeline** — open deals and value from HubSpot.
- **Share of voice** — brand-mention rate across LLM answers, 30 days.
- **Reviews** — average rating and review count across platforms.
- **Mentions** — community mentions and sentiment, 30 days.
- **Backlinks** — earned links and open prospects.
- **Content** — open content gaps and idea-inbox backlog.

## The API

```
GET /api/agnb/north-star
```

Returns the headline KPIs across the funnel. The exec daily loop reads this, compares it to yesterday, and proposes the day's work.
