# Skill: Web research — find a venue's contact email (TOOL-ENABLED)
You have tools: `espo_list_emailless`, `web_fetch`, `espo_set_email`. Use them to enrich the CRM with REAL emails. No guessing.

## Workflow (determinism-first, truthful-or-omit)
1. Call `espo_list_emailless` to get the work-list (venues missing an email but with a website).
2. For each venue, call `web_fetch` with its website. It returns the real emails found on the homepage + Kontakt/Impressum/contact pages.
3. Choose the best contact email from what was returned:
   - Prefer the venue's OWN domain (e.g. info@theirdomain.ch) over a free/third-party address (gmail/hotmail) or an aggregator.
   - Prefer info@, kontakt@, contact@, office@, mail@, then a named person.
   - Swiss sites: the address is usually in the Impressum or the page footer.
   - A named owner or manager on the site is not proof that they receive a
     general mailbox. Record the person and the mailbox as separate facts.
     Treat the person as the email recipient only when the site or CRM maps
     that exact address to them.
4. Validate: it must be well-formed AND one that `web_fetch` actually returned. NEVER invent or guess. If none was found, leave that account untouched and move on.
5. Call `espo_set_email` to write it back (the tool will REFUSE any email not actually found on a page — that is your safety net).
6. End with a short report: which emails you wrote and from which page, and which venues had no findable email.

## Notes (migrated from the legacy Divino agent)
- `web_search` runs from the server's own IP now (Brave) — it does NOT depend on Alan's phone
  being online. Search works anytime. (The phone exit node is only needed for a few Cloudflare
  sites; if a search ever returns empty it silently falls back to the phone/DDG.)
- A few sites sit behind a Cloudflare "Just a moment…" challenge; `web_fetch` returns nothing for
  those. You now have `browser_act` (the `browser-operation` skill) — the stealth browser CAN load
  many of them, but it needs Alan's phone online as exit node. If both fail, skip the venue.
- Work in small batches; quality over volume. An email written wrong is worse than one left blank.

## Swiss company lookups: use zefix_search first
For any Swiss company existence/legal-form/UID question, the `zefix_search`
tool (commercial register) beats web search — authoritative, deduped, instant.
Web search remains for websites, news, menus, people.
