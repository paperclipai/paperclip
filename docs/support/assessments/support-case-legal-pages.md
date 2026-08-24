# Support Case Assessment: Legal Pages Release (v0.2.12)

**Feature**: Privacy Policy and Terms of Service pages on voyonder.com
**Assessed by**: Support Engineer
**Date**: 2026-08-15
**Related**: VOY-1150, VOY-1035, VOY-975, VOY-1158
**Release**: v0.2.12

## Feature Overview (User Perspective)

Voyonder now has full legal pages at `/privacy` and `/terms` on voyonder.com. These pages contain:
- **Privacy Policy**: How data is collected, used, shared, and protected
- **Terms of Service**: The rules governing use of the Voyonder platform

Legal links are available in the footer of every public page. The signup flow requires accepting the Terms of Service via a single checkbox before account creation.

## Key Legal Disclaimers (Support-Relevant)

The Terms of Service include several disclaimers that customers may ask about:

1. **Not a travel agency** — Voyonder does not book flights, hotels, or activities. It is a planning tool only.
2. **Not a travel insurer** — Voyonder does not provide travel insurance. Customers are directed to purchase from licensed providers.
3. **Not a guarantor** — Voyonder does not guarantee availability, pricing, or quality of any travel service.
4. **Not a visa/documentation service** — Customers are responsible for their own travel documentation.

## Potential User Confusion Points

1. **"I thought Voyonder booked my trip"** — Some users may believe Voyonder handles bookings. The TOS clearly states Voyonder is a planning tool. Support should clarify that Voyonder creates itineraries; users must make their own bookings.

2. **"Why won't you refund my hotel?"** — Voyonder does not process payments or hold money in trust. Refund requests must go to the hotel/booking provider directly.

3. **"Can I use Voyonder for business?"** — The TOS covers business use (planning trips for clients). Support should confirm business use is allowed but does not change the "planning tool" nature of the service.

4. **"What about my data?"** — The Privacy Policy covers data handling. Support should be familiar with the key points (what's collected, how it's used, how to request deletion).

5. **"Is my AI-generated itinerary owned by me?"** — Per terms, users own content they create. Voyonder claims no ownership of user-generated content.

## FAQ

**Q: Where can I find the Privacy Policy?**
A: At `/privacy` on voyonder.com, linked in the footer of every page.

**Q: Where can I find the Terms of Service?**
A: At `/terms` on voyonder.com, linked in the footer of every page.

**Q: Why does Voyonder say it's not a travel agency?**
A: Voyonder is an AI-powered planning tool that helps you create itineraries. We don't book flights, hotels, or activities on your behalf. We plan the trip; you make the bookings.

**Q: Does Voyonder offer refunds?**
A: Voyonder offers subscription refunds per our cancellation policy. We do not issue refunds for third-party travel services (hotels, flights, etc.) — those are handled by the provider.

**Q: What data does Voyonder collect?**
A: See our Privacy Policy at `/privacy` for a complete description. Generally: account information, trip preferences, and usage data.

**Q: Can I delete my account and data?**
A: Yes. Contact support or use the account settings page. See the Privacy Policy for data deletion procedures.

## Troubleshooting

### Customer reports seeing internal metadata on legal page
1. Verify the page URL is `voyonder.com/terms` or `voyonder.com/privacy`
2. Check if cached version is being served — try incognito mode or hard refresh
3. If metadata is still visible, escalate: BUG-1 fix may not have been properly deployed

### Customer can't find legal pages
1. Ensure they're on `voyonder.com` (not a cached version of `.app`)
2. The footer is available on all public pages including `/privacy`, `/terms`, `/pricing`
3. Direct links: `https://voyonder.com/privacy`, `https://voyonder.com/terms`

### Customer sees duplicate terms checkbox at signup
1. This was fixed in v0.2.10/v0.2.12 — there should be one checkbox now
2. Clear browser cache and reload the join page
3. If still seeing two checkboxes, the cached JavaScript may be stale — hard refresh (Cmd+Shift+R)

### Customer asks about specific content in legal pages
1. Refer the customer to the live pages — they are the binding terms
2. For legal interpretation questions, direct to `legal@voyonder.com`
3. Support should not interpret or paraphrase legal language

## Error States

| Error | User sees | Root cause | Recovery |
|---|---|---|---|
| Legal page returns 404 | "This page could not be found" | Missing route or deployment issue | Verify page exists on voyonder.com; check deployment |
| Legal page shows internal metadata | "Author: CEO", "Status: Draft" visible | Stale cache or incomplete deployment | Hard refresh; if persists, BUG-1 fix needs redeployment |
| Footer missing from page | No legal links visible | Page outside root layout; or redirect bypasses layout | Verify page path; most public pages should have footer |
| Join page shows two checkboxes | Duplicate terms acceptance checkbox | Stale JS bundle | Hard refresh; if persists, BUG-4 fix needs redeployment |

## Related Documentation

- `/privacy` — Privacy Policy (live on voyonder.com)
- `/terms` — Terms of Service (live on voyonder.com)
- `/documentation/releases` — v0.2.12 release notes
- `/documentation` — Main help center

## Escalation Path

| Issue | Severity | Escalate to | Notes |
|---|---|---|---|
| Legal pages 404 or broken | High | CTO / Release Engineer | Deployment issue |
| Legal content is incorrect | High | CEO / Legal team | Content change requires legal review |
| Internal metadata visible on live page | Medium | Release Engineer | BUG-1 fix may need cache purge or redeploy |
| Missing footer on page | Low | Staff Engineer | Page may be outside root layout hierarchy |
| Duplicate checkbox persists | Medium | Founding Engineer | CDN cache purge may be needed |
