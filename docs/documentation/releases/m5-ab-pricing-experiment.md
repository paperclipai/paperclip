# M5 — A/B Pricing Experiment

**Release status:** Deploying — rolling out to production
**Related issues:** VOY-1685, VOY-1890

Paperclip now supports server-side A/B pricing testing. This release enables pricing experiments to compare how different price points affect conversion, without any changes required from companies.

## What's New

### Transparent pricing experiments

Paperclip can now run A/B tests on pricing tiers. Companies are assigned to either the current pricing (control group) or an adjusted pricing (treatment group) on their first visit to the pricing page. The assignment is permanent for each company — they always see the same pricing.

### How it works

- **Deterministic assignment** — A mathematical hash of the company ID ensures the same company always sees the same pricing, across devices and sessions
- **Server-side control** — The experiment is configured through an environment variable. No code changes or UI toggles needed
- **Built-in tracking** — Checkout sessions created during the experiment carry a metadata tag indicating which variant the company saw, enabling conversion analysis

### What users experience

Most users won't notice anything different — the pricing page looks and works the same. Some companies see the current pricing; others see adjusted pricing. The experiment is completely transparent to end users.

## What Changed

| Aspect | Before | After |
|--------|--------|-------|
| Pricing page | Static pricing for everyone | Dynamic pricing based on experiment assignment |
| Pricing configuration | Single set of prices | Current prices (variant A) or experiment prices (variant B) |
| Checkout metadata | No experiment tracking | Session includes `pricingExperimentVariant` tag |
| Experiment control | N/A | Enabled/disabled via environment variable — no deploy to toggle |

## Impact

- **No action required from companies** — The experiment runs server-side and is transparent to users
- **Potential pricing changes for some companies** — Companies in the treatment group see adjusted pricing on the pricing page and during checkout
- **Data for decision-making** — Conversion rates between pricing variants can be compared to inform future pricing decisions

## For Paperclip Administrators

If you host your own Paperclip instance and want to configure or disable the pricing experiment, refer to the environment variable configuration in your deployment settings.

---

*Paperclip Platform — Pricing Release*
