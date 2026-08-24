# Community Launch Posts — Ready to Publish

*Drafted for PRA-921 launch sequence (Day 3+ of discord-community-plan.md). Publish gates: beta cohort live + Discord channels configured. Owner per plan: CEO (HN), CMO (Reddit), COO (seeding #showcase).*

---

## 1. Hacker News — Show HN (Day 3, owner: CEO)

**Title:** Show HN: I gave my startup an AI staff — agents that run their own project boards

**Body:**

I built [Voyonder](https://voyonder.com) — an AI travel concierge that plans personalized itineraries via a conversational agent (Sage). But the interesting part for HN is how we run the company itself: **we operate with AI employees on a control-plane board** (Paperclip).

Each agent has a role (COO, CTO, QA, Support Engineer), gets its own GitHub-style board with issues, works asynchronously, reports heartbeats, and defers to humans for approval gates. Our COO agent runs the board, triages blockers, and coordinates release cycles; the Support Engineer gates every release on documentation being in sync.

We're opening our community Discord for early adopters: https://discord.gg/m4HZY7xNG3

What's worked so far:
- Agents produce durable artifacts (docs, plans, test plans) instead of chat noise
- Blockers surface as issues with named owners instead of "who was supposed to do X?"
- Humans review decisions; agents execute the paper

What I'd love feedback on:
- How are you structuring agent-to-agent delegation without losing accountability?
- Where do you draw the human-approval line?

AMA about the setup — happy to go deep on the board mechanics.

**Posting rules:** Self-promotion is fine for Show HN, but keep it demo-focused, not marketing. No "upvote please". Reply to comments within the first hour.

---

## 2. Reddit — r/AIagents (Day 5, owner: CMO)

**Title:** We run our travel startup's ops with AI agents — opening early access + community

**Body:**

We've been dogfooding our own agent platform (Paperclip) to run Voyonder — an AI travel concierge. Right now we have AI agents acting as COO, CTO, QA, and Support Engineer, each working issues on a shared board with human review gates.

The experiment is going well enough that we're opening early access and a community Discord: https://discord.gg/m4HZY7xNG3

Early adopters get:
- Free access during beta
- Direct line to the founding team in #feedback
- Priority feature requests

We're specifically looking for feedback from people running agent-based ops: what's your delegation model? What breaks first at scale?

**Subreddit rules:** r/AIagents is product-friendly but wants substance over ads — the discussion framing above is the hook. Include the Discord link in a comment, not the title post, if the sub rules require it.

---

## 3. Reddit — r/SaaS (Day 5, owner: CMO)

**Title:** Building in public: how we shipped v0.5.0 with an AI ops team

**Body:**

Teardown of how Voyonder shipped its v0.5.0 release with AI agents doing ops coordination — release checklists, QA verification, docs gates — while two humans made the ship decisions.

Full details in the comments. Takeaways:
1. Agent heartbeats create a paper trail the whole team can audit
2. Named-blocker culture: every stuck issue has an owner + action
3. Docs-as-gate: nothing ships without the Support Engineer's sign-off

We're onboarding beta customers now — join the community Discord (https://discord.gg/m4HZY7xNG3) or DM me for access.

---

## 4. AI agent forums / newsletters (Day 5+, owner: CMO)

- **Indie Hackers** — post a "building in public" diary entry: "We hired AI employees (and they ship)" with a link to the Discord.
- **Latent Space / AI engineering newsletters** — pitch a short writeup on the board-driven agent workflow. Contact via their submission pages.
- **r/artificial, r/LocalLLaMA** (only if relevant) — keep to the agent-ops angle, not the travel product.

---

## 5. Seed content for #showcase (owner: COO, Day 1–3)

- Case study: Trail Life Troop WA-0337 committee runs on 10 AI agents (doc/outreach/case-study-trail-life.md)
- Case study: Voyonder travel ops (doc/outreach/case-study-voyonder-operations.md)
- Case study: Voyonder traveler experience (doc/outreach/case-study-voyonder-travel.md)
- Beta demo script (doc/outreach/beta-demo-script.md) as a "watch Sage in 10 minutes" post

---

## Publish Gate Checklist

- [ ] Beta cohort live (candidates from CEO Action 5)
- [ ] Discord channels configured + welcome/rules pinned (human admin)
- [ ] Invite link set to never-expire
- [ ] CEO approves HN title/body (self-promo sensitivity)
- [ ] CMO posts Reddit content per sub rules
