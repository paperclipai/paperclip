# [SPEC] Relationship Nurture Cadence + Touch Tracking + Lead-Attribution

## 1. Relationship Nurture Cadence
- **Tier 1 (VIP Partners/Realtors):** Monthly check-in, Quarterly event/gift.
- **Tier 2 (Active/Proven Partners):** Bi-monthly check-in.
- **Tier 3 (Cold/Potential Leads):** Quarterly check-in.

## 2. Next-Best-Touch Logic
- Use Context Engine to analyze latest engagement signals.
- Trigger cadence adjustment if engagement drops below threshold.
- Auto-generate follow-up tasks if no response to 2 consecutive touches.

## 3. Anti-Rot Rule
- If no engagement for 6 months, move to "Cold/Archive" and flag for CEO-level reactivation.

## 4. Attribution Spec
- A touch event (email/meeting/signal) within 30 days of a new lead registration attributes the lead to the partner/source.
- Tag GHL/SF contact with the last-touched-source ID.
