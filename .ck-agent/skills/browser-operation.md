# Skill: browser-operation — drive a real web browser like a person

You have a `browser_act` tool: a real stealth Firefox on a Swiss residential IP (Alan's
phone exit node). It lets you do anything a person can do on a web page — read it, click,
type, scroll, submit forms, run JavaScript. This is how you handle sites that plain
`web_fetch` / `web_search` can't: logins, JS-rendered pages, multi-step forms, portals.

## The loop: SEE, then ACT, then SEE again

Never act blind. Every task is a sequence of `browser_act` calls sharing one `tabId`:

1. `open {url}` → returns `tabId`. Keep it; pass it to every later call.
2. `snapshot {tabId}` → an accessibility tree of the page with element refs like `[e5]`.
   This is how you SEE. Read it before every action.
3. Act by ref: `click {tabId, ref:"e5"}` or `type {tabId, ref:"e7", text:"...", pressEnter:true}`.
   (You may use `selector:"#id"` instead of a ref when you know the CSS selector.)
4. `snapshot` again to confirm what changed. Repeat.
5. `close {tabId}` when done. Always close.

Other actions: `navigate {tabId,url}`, `press {tabId,key:"Enter"}`, `scroll {tabId,direction:"down"}`,
`links {tabId}` (all links), `screenshot {tabId}` (returns image data, not shown to you inline —
use snapshot to read; screenshot is for saving proof), `evaluate {tabId, expression}` (run any JS,
returns the result — the escape hatch when refs aren't enough).

Add `waitMs` (up to 15000) to any action to let the page settle after it.

## The #1 gotcha: native confirm()/alert() silently block form submits

Many sites pop a native `confirm("Are you sure?")` on submit. A real browser waits for a human
click; automation auto-dismisses it → the submit is silently cancelled, no error, page unchanged.
It looks exactly like an anti-bot wall — it usually isn't.

**Before clicking a submit/publish button, call `allow_dialogs {tabId}`.** It sets
`window.confirm`/`alert` to auto-accept for that tab. Then do the real click. (This one lesson
is what unlocked automated listing on lapulga.com.do after weeks of failure — see the
`marketplace-autolisting` skill.)

If a submit still does nothing: `evaluate` and read the site's own form JS
(`document.querySelector('form').outerHTML`, or fetch its script) to find what the submit handler
requires — hidden fields populated on submit, HTML5 `checkValidity()`, etc. Read, don't guess.

## GOVERNANCE — this tool reaches the outside world. Treat it like send_email.

`browser_act` can submit forms and send messages to real people. The same rules that bind
`send_email` bind you here — there is NO automatic technical gate on this tool, so the discipline
is yours:

- **Do-not-contact is absolute.** Never contact Suvretta, or any cigar producer (Davidoff,
  Patoro, Zigarren Dürr, etc.). See the `do-not-contact` skill. This applies to filling a contact
  form just as much as to email.
- **Reading is free. Sending is gated.** Navigating, snapshotting, searching, extracting — do
  freely. But before you SUBMIT anything outward (a contact form, a message, a listing, a
  booking), `request_decision` first and get Alan's approval, unless your charter explicitly
  authorizes that specific action.
- **Never invent what a page said.** Report what the snapshot actually shows. If a page failed to
  load, say so — don't fabricate a result.
- **Disclosure rules still apply.** Never name "CK IT Solutions GmbH" or reveal the TH relay in
  anything you type into a page. See `disclosure-guard`.

## When the tool errors

"browser bridge unreachable / is the phone online as Tailscale exit node?" → the stealth browser
depends on Alan's phone being online as the exit node. Report it; don't retry in a tight loop.

## What this is good for
Contact-form-only venues (no email to scrape), JS/portal sites web_fetch returns empty on,
logging into a supplier/booking portal, verifying a live listing, filling a marketplace form.
For pure email discovery use `web_fetch` first (cheaper); reach for `browser_act` when a page
needs real interaction.
