# Skill: zefix-search — Swiss commercial register (Zefix) for prospecting
Zefix = the Swiss federal commercial register. Free public data on every
registered Swiss company. Migrated from the legacy Hermes agent's workflow.

## Primary method: the zefix_search TOOL (no browser)
Call the `zefix_search` tool with several overlapping terms — results are
UID-deduplicated: `{"terms":["Zigarren","Tabak","Cigar","Humidor"],"max_per_term":40}`.
Returns name, seat, legal form, UID, status. Overlapping terms matter: a
"Cigar Lounge" won't match "Zigarren". After searching, ALWAYS apply the
do-not-contact rules (producers/brands, Suvretta, already-in-CRM) before
proposing anything.
(Why a tool: the official zefix.admin.ch PublicREST API returns 401 without a
registered account, but zefix.ch's own JSON endpoint is open — the tool uses it.)

## Fallback knowledge: browser automation on zefix.ch (and Angular sites generally)
Only relevant for agents with a real browser. Lessons that cost hours to learn:
1. Angular/React reactive inputs IGNORE `input.value = "x"`. Use the native
   setter + events: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
   "value").set.call(input, "term")` then dispatch `input`/`change`/`blur`.
2. Clicking the "Suchen" button often does nothing — dispatch `submit` on the
   parent form instead.
3. Dismiss the cookie-consent overlay first ("Einverstanden"), or clicks
   silently no-op.
4. "exakte Suche" is ON by default → broad terms return 0 results. Uncheck it.
These four generalize to most modern reactive-framework websites.

## Legal forms (official ids): 1 Einzelunternehmen · 3 AG · 4 GmbH ·
5 Genossenschaft · 6 Verein · 7 Stiftung · 9/11 Zweigniederlassung · 10 KmG
