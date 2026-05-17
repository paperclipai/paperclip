# Early-Access Waitlist & Referral Mechanics

## Overview

Two-stage waitlist system: users sign up for beta access, earn priority by referring colleagues.

---

## Stage 1: Waitlist Signup

### Entry Points
- Landing page hero CTA ("Join the Beta Waitlist")
- Blog post CTAs
- LinkedIn content CTAs
- Direct share links from beta testers

### Signup Flow
1. User lands on waitlist form
2. Fills in: Name, Email, Role, Organization (optional), Referral Source
3. Submits → receives confirmation:
   - **Email**: "You're on the list — here's your spot #[N]. Share with colleagues to move up."
   - **Auto-reply**: Includes personalized referral link

### Position Tracking
- Each signup gets a **queue position** (sequential)
- Queue position improves with successful referrals

---

## Stage 2: Referral Mechanics

### How It Works
- Every signup receives a **unique referral link**: `crewbrief.avva.aero/join?ref={code}`
- Referrer earns **+5 queue positions** per successful referral
- Referral is "successful" when the referred user completes signup with a valid email

### Tiers
| Tier | Referrals | Benefit |
|---|---|---|
| Standard | 0 | Queue position + waitlist |
| Priority | 3+ | Skip ahead to front of beta wave 1 |
| Insider | 5+ | Priority access + beta tester badge + direct feedback channel |

### Referral Dashboard (in confirmation email)
- "Your referral link: `crewbrief.avva.aero/join?ref={code}`"
- "Referred: 0 | Priority at 3 | Insider at 5"
- "Share on LinkedIn | Share via Email | Copy Link"

---

## Stage 3: Beta Cohort Rollout

### Cohort Structure
| Wave | Size | Criteria | Timing |
|---|---|---|---|
| Wave 1 | 5 operators | Insider tier + Part 135 operators | Week 1 |
| Wave 2 | 10 operators | Priority tier + mix of segments | Week 2 |
| Wave 3 | Open | All waitlist + public | Week 4+ |

### Activation Email
- "Welcome to CrewBrief Beta — here's your onboarding guide"
- Links to: onboarding steps, feedback channel, community forum
- Includes: personalized login or API key

---

## Technical Requirements

### Backend (to implement)
- Signup form endpoint: `POST /api/waitlist/signup`
- Referral code generation (random 8-char alphanumeric)
- Referral tracking table: `referral_id, referrer_email, referee_email, created_at, status`
- Queue position calculator (signed up at timestamp × referrals bonus)
- Waitlist admin dashboard: total count, referral stats, cohort management

### Email Templates
1. **Confirmation**: "You're on the CrewBrief beta waitlist — spot #[N]"
2. **Referral invite**: "[Name] thinks you'd love CrewBrief — get early access"
3. **Wave invitation**: "Your beta access is ready — start your first briefing"
4. **Reminder**: "Still interested? Your spot is waiting"

### Analytics Events
- `waitlist_signup` — with referral source
- `referral_link_shared` — CTA click
- `referral_conversion` — referred signup completes
- `beta_invitation_sent`
- `beta_activation` — first briefing generated
