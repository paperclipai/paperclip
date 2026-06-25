# Handoff — First-run Companion Guide (UI)

**Built by:** UI/UX session · **For:** runtime/deploy session · **Date:** 2026-06-24
**Status:** built + wired + `tsc -b` clean (0 errors). **Not deployed** (deploy is your lane).

## What this is
A first-run **companion guide** — a calm, stepped GLASSHOUSE pop-up that teaches a new
tenant owner how to *run their company*. 7 steps: Welcome → Your team → Goals/delegation →
Issues (= execution) → Ask the Chief of Staff → Routines → Costs/you're-set. Each step after
the first has an "Open <X> →" deep link to the real destination.

## Files (the entire change — UI only, no backend/migrations/deps)
- **NEW** `ui/src/components/CompanionGuide.tsx` — the component (self-contained).
- **EDIT** `ui/src/components/Layout.tsx` — import + `<CompanionGuide />` mounted next to the
  other global overlays (after `<ToastViewport />`).
- No new dependencies (uses existing `lucide-react`, `@/components/ui/dialog`, `button`, `@/lib/router`).

## Behavior / gating
- Auto-opens **once per browser** via `localStorage["valadrien-os.companionGuideSeenV1"]`,
  only inside a company context (gated on `useParams().companyPrefix`), 600ms after mount.
- Dismiss (Skip / Done / Esc / overlay) sets the flag; it won't reappear.
- **Replay** from anywhere: `window.dispatchEvent(new Event("valadrien-os:open-companion-guide"))`
  (exported as `OPEN_COMPANION_GUIDE_EVENT`).

## Design conformance (GLASSHOUSE / DESIGN.md)
- Newsreader serif titles (`font-serif`), Hanken body, JetBrains mono eyebrows/counter
  (`font-mono`, UPPERCASE, `tracking-[0.18em]`). Sodium accent rationed (eyebrow, rail, dots,
  deep link, primary button). Square panel (`rounded-none`), `bg-card`, hairline border.
- **No decorative motion** — the left Sodium rail is a *static* signal (honors "motion is bound
  1:1 to a real event"). Only Radix's own dialog enter/exit + step swaps; reduced-motion safe.

## To ship
1. Build: `pnpm -C ui build` (or your normal UI build/deploy). `tsc -b` already passes.
2. Deploy the UI as usual.
3. Smoke test: clear `localStorage["valadrien-os.companionGuideSeenV1"]`, load a company
   route (e.g. `/VEN/dashboard`) as a fresh owner → guide should appear; Next/Back/Skip work;
   deep links route under the company prefix.

## Suggested follow-ups (optional, not required)
- Add a **"Replay guide"** button in Company Settings that dispatches `OPEN_COMPANION_GUIDE_EVENT`.
- If you want **cross-device** first-run (not per-browser), gate on a server `user.onboardedAt`
  (or company-membership `createdAt`) instead of/alongside the localStorage flag.
- Tenant owners like Venco's **Vanessa Celestin (admin@vencoai.com)** are the exact audience.
