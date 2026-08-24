# Support Case Assessment: Domain Revert to voyonder.com

**Feature**: Domain reversion from voyonder.app → voyonder.com
**Assessed by**: Support Engineer
**Date**: 2026-08-15
**Related**: VOY-1140, VOY-1035, VOY-975
**Release**: v0.2.10

## Feature Overview (User Perspective)

Voyonder operates at voyonder.com. Users access the application, sign up, manage billing, and read documentation at `voyonder.com`. The `.app` domain migration that was in progress has been deferred — production remains at `.com`.

For users, nothing changed. The domain has always been voyonder.com from their perspective. The migration to voyonder.app was technical infrastructure work that was not user-facing before being deferred.

## Potential User Confusion Points

1. **"I saw voyonder.app somewhere"** — Some cached emails, pages, or external references may still show voyonder.app. The correct domain is always voyonder.com. This is a cache/staleness issue, not a functionality problem.

2. **"Is voyonder.app a scam site?"** — voyonder.app is owned by Voyonder and resolves to the same infrastructure. It's not a scam, but the canonical domain is voyonder.com. Users should use voyonder.com.

3. **"I bookmarked voyonder.app — will it still work?"** — voyonder.app still resolves (infrastructure forwards), but the canonical URL is voyonder.com. Bookmarks will work but should be updated.

4. **"I received an email from support@voyonder.app"** — Stale email template in a cached send. All official emails now come from `@voyonder.com` addresses. The `.app` variant is deprecated.

## FAQ

**Q: What domain should I use for Voyonder?**
A: `https://voyonder.com` is the correct domain for all Voyonder services.

**Q: Does voyonder.app still work?**
A: voyonder.app currently resolves but is not the primary domain. We recommend using voyonder.com.

**Q: Why did the domain change?**
A: The domain hasn't changed from the user's perspective — Voyonder has always been at voyonder.com. A planned migration to voyonder.app was deferred.

**Q: What email addresses does Voyonder use?**
A: Official Voyonder emails come from `@voyonder.com`. Support is `support@voyonder.com`. Privacy inquiries go to `privacy@voyonder.com`.

**Q: Will the .app migration happen later?**
A: The migration is deferred. If it proceeds, there will be advance notice and clear communication.

## Troubleshooting

### Customer reports voyonder.app in an email
1. Check the email source — if it references voyonder.app, it's a stale template
2. Assure the customer that voyonder.com is the correct domain
3. If the email contains links, they should still resolve to voyonder.com (redirects are in place)

### Customer can't access /settings/billing
1. Clear browser cache and cookies
2. Try incognito/private browsing mode
3. Ensure the user is logged in (billing requires authentication)
4. If the page is blank, it was a prerender crash — the force-dynamic fix resolves this
5. If still broken, escalate: the fix may need a server restart or cache clear

### Customer sees duplicate terms checkboxes at signup
1. This was fixed in v0.2.10 — there should be one checkbox now
2. Clear browser cache and reload the join page
3. If still seeing two checkboxes, the cached JavaScript may be stale — hard refresh (Cmd+Shift+R)

### Customer reports missing footer on a public page
1. The footer was moved to the root layout in v0.2.10
2. Pages outside the root layout (e.g., some error pages, full-screen layouts) may not have the footer
3. Most public pages (/privacy, /terms, /pricing, /documentation, /gallery, /blog) should have the footer
4. Verify the page is not being redirected before the layout renders

## Error States

| Error | User sees | Root cause | Recovery |
|---|---|---|---|
| Billing page blank/500 | Blank page or server error at /settings/billing | Prerender crash (billing page not marked force-dynamic) | Fixed in v0.2.10 — force-dynamic prevents prerender |
| Duplicate terms checkbox | Two checkboxes on /join | VOY-1017 checkbox not removed after VOY-1033 consolidation | Fixed in v0.2.10 — single checkbox remains |
| voyonder.app in email | Email template references .app domain | Stale cached email template | Templates updated; cache will clear on next send |
| Legal page shows metadata | "Author: CTO", "Status: Draft" visible on /privacy or /terms | Internal document metadata not stripped before rendering | Fixed in v0.2.10 — metadata stripped |

## Related Documentation

- /documentation — Main help center (domain info in Getting Started)
- /documentation/releases — v0.2.10 release notes
- /privacy — Privacy Policy
- /terms — Terms of Service

## Escalation Path

| Issue | Severity | Escalate to | Notes |
|---|---|---|---|
| Billing page crash persists | High | CTO | force-dynamic fix may need server restart |
| voyonder.app still referenced in critical email | Medium | Release Engineer | Email template may need manual flush |
| Duplicate checkbox on join page | High | Founding Engineer | JS bundle may be cached — CDN purge needed |
| Footer missing from page | Low | Staff Engineer | Page may be outside root layout hierarchy |
