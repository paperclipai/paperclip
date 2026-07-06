# 027 — Mobile Push Notifications & Fast Approvals

## Suggestion

The README sells managing your autonomous companies **"from your phone,"** and the UI is
mobile-aware (responsive sidebar/drawer in `useKeyboardShortcuts.ts`, `plugins/bridge.ts`). But
the actual mobile experience is just a shrunken desktop board — there's no **push notification**
when something needs you, and no streamlined mobile flow for the one thing operators most need
to do on the go: **approve or reject**. An autonomous company runs 24/7; the human is the
bottleneck precisely when they're away from their desk. If approvals can't reach you on your
phone, autonomy stalls every evening and weekend.

Deliver on the phone promise: **web push notifications** for the events that need a human, plus a
fast, mobile-first approval flow.

## How it could be achieved

1. **Web Push (PWA).** Add a service worker and the Web Push API so the existing React UI can be
   installed as a PWA and receive notifications even when closed — no native app needed. The
   live-events websocket (`live-events-ws.ts`) and sidebar badges (`sidebar-badges.ts`) already
   model "something needs attention"; push is a new delivery channel for the same signals.
2. **Notify on what matters.** Approvals awaiting the operator, budget warn/hard-stop incidents
   (`budgets.ts`), emergency-stop triggers (idea 014), and chronic fallbacks/leaks (ideas 012,
   020). Reuse the risk score from approval triage (idea 016) so only high-signal events buzz the
   phone — notification fatigue would kill this feature.
3. **Approve from the notification.** Deep-link a push straight into a single-item approval card
   with the run change-review diff (idea 017) inline and big approve / reject / "request changes"
   actions — reviewable in ten seconds one-handed.
4. **Quiet hours + batching.** Respect operator-set quiet hours (compose with idea 005) and batch
   low-priority items into a periodic summary push instead of buzzing per event.
5. **Per-user delivery prefs.** With multiple human users (a shipped roadmap item), let each
   choose channels and thresholds.

## Perceived complexity

**Medium.** Web Push + service worker is well-trodden but new surface area for this codebase
(subscription management, VAPID keys, a worker, per-user delivery prefs). The signals to notify
on already exist; the work is the delivery pipeline and a genuinely good mobile approval card.
Biggest design risk is notification quality — gating on the existing risk score is what keeps it
useful rather than annoying. A scheduled digest push (idea 029) is a low-effort first slice that
proves the pipeline before per-event push.
