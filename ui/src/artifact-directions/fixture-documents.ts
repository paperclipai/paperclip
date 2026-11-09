/**
 * Markdown bodies for the acmehats fixture documents. The openings reproduce
 * what the reference screenshots show; the rest is written to match.
 */

export const DOC_CRITIQUE = `# Interface Craft critique — acmehats additional design pass

28 September 2026. Applied Josh Puckett's Design Critique from the [saved skill source](#document-interface-craft-source), using the previous revision's rendered 12-slide contact sheet and its layout source. Scope: static presentation; interface checks adapted to slides.

## Findings

- Repetitive cards flatten hierarchy: nine of twelve slides used the same three-card row.
- Cap imagery arrives late. The first product silhouette appeared on slide 9.
- The final review slide asked for approval without separating the decisions.

## Implemented changes

- Cap-led cover with the supplied logo retained.
- Strategy hierarchy reduced to one claim, one proof, one open question per slide.
- Matched A/B comparison fields and applications across both directions.
`;

export const DOC_GUIDE_VERIFICATION = `# Interface Craft deck guide and verification

Revision 3 • 28 September 2026 • 12 slides • 16:9

## What changed in this revision

The deck keeps the approved strategy and both visual directions. Layout, sequence and emphasis changed; claims did not.

## Verification

- Both files reopen with 12 slides/pages and identical visible text.
- All PDF pages were visually inspected with no clipping or unintended overlap.
- Text and shapes are editable; the supplied logo remains raster.
- Native PowerPoint rendering remains untested; the PDF is the inspected reference.
`;

export const DOC_SUPPLIED_SOURCE = `# Interface Craft — supplied source

Source: https://interfacecraft.dev/api/install-skills, supplied by the user on 28 September 2026. Embedded Markdown files were decoded without running the installer. Company import is unavailable to this run (route denied). This document preserves the exact relevant skill content for this revision.

## Design Critique

Review the interface the way a senior designer would: start from what the screen is for, then hierarchy, then rhythm, then detail.
`;

export const DOC_REVISION_BRIEF = `# Approved consolidated deck revision brief

Approved by the CEO on 26 September 2026. One consolidated revision is authorized before founder review.

## Scope

- Keep Direction A — The Local Signature as the recommendation.
- Tighten the strategy slides; remove duplicated audience claims.
- Label every fictional café concept as an assumption.

## Out of scope

New directions, new claims, and any public use of the supplied logo.
`;

export const DOC_REVISION_NOTES = `# Consolidated revision notes

Revision of 26 September 2026 against the approved brief.

- Slides 2–4 merged into a single audience and opening slide.
- Source notes moved to the appendix and linked from each claim.
- Cap label overlap on slide 9 corrected and rechecked in the PDF.
`;

export const DOC_FIRST_DRAFT_VERIFICATION = `# First-draft deck guide and verification

First draft • 25 September 2026 • 12 slides • 16:9

## Verification

Rendered and visually inspected all 12 PDF pages; corrected cap/label overlap and rechecked. Both files reopen, contain 12 pages/slides and identical visible text.
`;

export const DOC_VISUAL_STRATEGY = `# Visual direction strategy

Two directions are developed from the approved brand strategy.

## Direction A — The Local Signature

Deep green and cream, a serif wordmark, and the customer's own name leading on the cap.

## Direction B — The Shared Mark

Cobalt and sun yellow, a bold stacked mark, built for groups that want to be seen together.
`;

export const MD_FIRST_DRAFT_GUIDE = `# acmehats first-draft deck guide

First draft • 25 September 2026 • 12 slides • 16:9

## Recommendation and review path

Develop **Direction A — The Local Signature**. Its restraint suits independent cafés and hospitality teams, and it leaves room for each customer's own name to lead.

## Sources and assumptions

- Audience and claims come from the approved brand strategy (ACM-2).
- Café concepts are fictional and labelled as assumptions on each slide.
`;

export const MD_INTERFACE_CRAFT_GUIDE = `# acmehats Interface Craft deck guide

Interface Craft revision • 28 September 2026 • 12 slides • 16:9

## Sources, assumptions, editing notes and verification

The revision applies the saved critique method to the consolidated deck. Strategy, audience and claim labels are unchanged from the approved brief.

## Editing notes

- Fonts: Georgia and Helvetica Neue, both system fonts.
- Every text box and shape is a native, editable object.
`;

export const MD_REVISED_GUIDE = `# acmehats revised deck guide

Consolidated revision • 26 September 2026 • 12 slides • 16:9

## What to review

The recommendation is unchanged. Review the merged audience slide and the appendix of sources first.
`;

export const DOC_CEO_REVIEW = `# Interface Craft pass — CEO review

28 September 2026. Ready for founder review; acceptance remains pending.

[Review PDF](#work-product-ic-pdf) · [Editable PowerPoint](#work-product-ic-pptx) · [Editing source and fonts](#work-product-ic-zip).

## Context

A 12-slide strategy and direction deck for an early-stage custom cap business. This additional pass follows the founder's request to apply the Interface Craft critique method before acceptance.

## Recommendation

Accept the Interface Craft revision as the first brand deck and authorize Direction A for production samples.
`;

export const DOC_FIRST_DRAFT_REVIEW = `# First draft — CEO review

25 September 2026. The first draft is coherent and its claims are labelled. One consolidated revision is authorized before founder review.
`;

export const DOC_ONBOARDING_PLAN = `# acmehats onboarding plan

## Week one

- Agree the brand strategy and designer brief (ACM-2).
- Produce two visual directions and a first brand deck (ACM-3).

## Week two

- Launch email sequence, product photography and the wholesale pricing model.
`;

export const DOC_FOUNDER_QUESTIONS = `# Founder questions and decisions

Open decisions collected during onboarding.

1. Which direction goes to production samples?
2. Is the supplied logo final, or a placeholder?
3. Minimum order quantity for café customers.
`;

export const DOC_BRAND_STRATEGY = `# acmehats — brand strategy and designer brief

Version 1 • 25 September 2026 • ACM-2 • Strategy recommendation for founder review

## Recommendation and authority

Focus initial brand exploration on independent cafés and hospitality businesses buying custom caps for staff and regulars. The founder retains approval of positioning, claims and any public use.

## Designer brief

Develop two visual directions that let a customer's own place lead, and present them as a 12-slide deck.
`;

export const DOC_LAUNCH_SEQUENCE = `# Launch sequence — five emails

Five emails over twelve days for the café waitlist.

## 1 · Your place, on a cap

Subject: Your café deserves its own cap. Introduce the idea with one photograph and one sentence.

## 2 · How it works

Three steps: send your name, approve the proof, receive the box.
`;

export const DOC_SUBJECT_LINES = `# Subject line variants

Three variants per email for the first send.

- Your café deserves its own cap
- The cap your regulars will ask about
- Made for the people behind the counter
`;

export const DOC_WELCOME_EMAIL = `# Welcome email — draft

Hello, and thank you for joining the acmehats list.

We make custom caps for independent places: cafés, bakeries, bars and the people who keep them running. Your first proof is free.
`;

export const DOC_PRICING_ASSUMPTIONS = `# Pricing assumptions and sources

## Assumptions

- Blank cap cost falls from $6.40 to $4.90 between 24 and 240 units.
- Embroidery setup is a one-off $45 per design.
- Target gross margin is 52% at the 48-unit tier.
`;

export const CSV_AUDIENCE_SEGMENTS = `segment,contacts,open_rate,first_send
Independent cafés,1840,0.46,2026-10-06
Bakeries and delis,920,0.41,2026-10-06
Bars and taprooms,610,0.38,2026-10-08
Clubs and makers,455,0.35,2026-10-08`;

export const HTML_EMAIL_TEMPLATE = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f6f0e1;font-family:Georgia,serif">
    <table role="presentation" width="100%">
      <tr><td align="center" style="padding:32px">
        <h1 style="color:#1f4d3a">Your place, on a cap.</h1>
      </td></tr>
    </table>
  </body>
</html>`;

export const JSON_BRAND_TOKENS = `{
  "color": {
    "forest": "#1f4d3a",
    "cream": "#f6f0e1",
    "cobalt": "#1f44c8",
    "sun": "#f4c81f"
  },
  "type": { "display": "Georgia", "text": "Helvetica Neue" }
}`;

export const CSV_PRICING_TIERS = `units,blank_cost,embroidery,unit_price,margin
24,6.40,3.10,24.00,0.41
48,5.80,2.60,21.00,0.52
120,5.20,2.20,18.50,0.55
240,4.90,1.90,16.00,0.56`;
