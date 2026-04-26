---
name: lead-handoff-protocol
description: Standards for how Bobby Tours sites capture and hand off sales leads — WhatsApp CTA placement, inquiry form fields, email sequence (Resend), no-PII-in-logs, per-site email domain. Use when building contact forms, writing CTA copy, or reviewing lead-capture PRs.
---

# Lead Handoff Protocol

## The 6 allowed emails (one per site + one operator)

Canonical per hook v12 P7:

| Site | Email |
|---|---|
| safaris-tanzania.com | `travel@safaris-tanzania.com` |
| mountkilimanjaroclimb.com | `summit@mountkilimanjaroclimb.com` |
| magicaltanzania.com | `travel@magicaltanzania.com` |
| bobbysafaris.com | `travel@bobbysafaris.com` |
| safarikilimanjaro.com | `travel@safarikilimanjaro.com` |
| Operator | `kasssim@bobbytours.com` (note: 3 's's in kasssim — deliberate) |

Any other email in source = hook v12 P7 rejection.

## The 1 allowed WhatsApp

`+255786110786` — Tanzania country code + Don's number. Every CTA that deep-links WhatsApp uses `https://wa.me/255786110786?text=<URL-encoded message>`.

## WhatsApp CTA placement rules

1. **Above the fold** on every landing page and itinerary page.
2. **Final page CTA** — sticky bottom-bar or in-content card at end of every page.
3. **Mobile nav** — dedicated WhatsApp button in mobile menu (green icon).
4. **Exception**: Blog posts — WhatsApp CTA in the "Plan your trip" closing section only (not above fold).

### CTA copy (per site)

| Site | Above-fold CTA | Closing CTA |
|---|---|---|
| bobbysafaris.com | "Contact Don directly" | "Reach Don on WhatsApp — he reads every message personally" |
| safaris-tanzania.com | "Plan your safari" | "Send a WhatsApp — direct-operator, no broker fees" |
| magicaltanzania.com | "Talk to our travel experts" | "Message us — we'll reply with unbiased camp recommendations" |
| safari-kilimanjaro.com | "WhatsApp for a quote" | "WhatsApp us — combo Kili+Safari, no hidden fees" |
| mountkilimanjaroclimb.com | "Plan your Kili climb" | "WhatsApp Mt. Kili climb experts — 96% summit rate this season" |

WhatsApp pre-filled text — always include the source page URL for attribution:
```
https://wa.me/255786110786?text=Hi%20Don%2C%20I%20was%20looking%20at%20https%3A%2F%2Fbobbysafaris.com%2Fitineraries%2Fserengeti-7-days
```

## Inquiry form fields (minimum required)

```tsx
{
  name: string,        // required
  email: string,       // required, validate with zod email
  phone: string,       // optional but encouraged, E.164 with country code
  travelers: number,   // required, min 1
  startDate: string,   // optional, ISO date
  duration: number,    // optional, days
  message: string,     // optional, <=2000 chars
  source_url: string,  // auto-populated, for attribution
  site: string,        // auto-populated, which site sent this
  locale: string,      // auto-populated, UI language at time of submit
}
```

### Validation rules
- Email: RFC-valid, no +plus tags considered suspicious
- Phone: E.164 OR free-text with country code
- Message: strip HTML, max 2000 chars, reject if > 5 URLs in body (spam)

## Email handoff (Resend)

### Auto-response flow (within 2 min of submit)

1. **Immediate confirmation** to user:
   - From: `<site>-canonical-email` (per table above)
   - Subject: "We received your inquiry — [Site Brand]"
   - Body: short, human tone, set expectation ("Don will reply within 24 hours on weekdays")
   - Include WhatsApp link as alternative contact

2. **Forward to operator** (Don):
   - To: `kasssim@bobbytours.com`
   - From: `<site>-canonical-email`
   - Subject: `[<SITE>] New inquiry: <name> — <travelers> travelers`
   - Body: all form fields + user-agent + timestamp + source_url

### Follow-up sequence (3 emails over 10 days)

| Day | From | Subject | Content |
|---|---|---|---|
| 1 (confirmation) | site email | "Thanks, <name>" | Confirmation + expectation + WhatsApp |
| 3 | site email | "A sample itinerary you might like" | Relevant itinerary PDF + soft ask |
| 10 | site email | "Still interested?" | Low-friction re-engagement, WhatsApp + quick reply options |

All emails: plain text > HTML. Keep under 150 words. No tracking pixels unless legally disclosed.

## Data handling + PII

- **Never log** full email/phone/name in server logs. Mask (`d***@g***.com`) if logging for debug.
- **Never commit** `.env` with Resend API keys, inquiry form data, or lead names.
- **Opt-out** — every email must have working unsubscribe (serve `/unsubscribe?token=<signed>`).
- **Retention** — leads older than 90 days with no reply from operator: auto-archive (no deletion yet — check with operator before building purge).
- **Consent** — inquiry form must have GDPR-compatible checkbox: "I agree to receive replies about my inquiry and Bobby Tours emails."

## Procedure (for coder / reviewer)

1. **On every form PR**, verify:
   - [ ] Uses canonical email for this site
   - [ ] WhatsApp link uses `+255786110786`
   - [ ] Zod schema validates all fields
   - [ ] Resend integration uses env variable (not hardcoded key)
   - [ ] Success/error states accessible (per `accessibility-audit`)
   - [ ] No PII logged

2. **On every landing page PR**, verify WhatsApp CTA placement rules (above fold + closing).

3. **Hook v12 P7 + P8 will reject** any commit that uses wrong email or wrong WhatsApp number. Don't fight the hook — fix the source.

## Pitfalls

- **Don't hardcode `+255 786 110 786`** (with spaces) in links — `wa.me` requires digits only.
- **Don't use a second email** "for admin" — only the 6 canonical ones.
- **Don't forget locale in emails** — if the user submitted via `/de/`, reply in German. Use `locale` field.
- **Don't auto-reply from `travel@bobbytours.com`** (4 's's = wrong) or `travel@bobbytours.cloud` (internal domain) — use the per-site canonical email.

## Related skills

- `site-voice-<slug>` — CTA + email copy tone
- `accessibility-audit` — form labels, errors, keyboard nav
- `meta-description-writer` — CTA verbs + keyword alignment
- Hook v12 P7, P8, P14 enforcement

## Budget

$0.10–0.30 per review.
