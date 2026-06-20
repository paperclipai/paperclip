# Content Pipeline Setup Report

**Date:** March 30, 2026

---

## How the LinkedIn Pipeline Works

### Current State (before this session)
- `daily-content.sh` runs at 7 AM via cron — sends a Telegram message via openclaw asking for a LinkedIn post draft. Does NOT actually post.
- `contentbot` at `~/qsl-swarm/CABINET/contentbot/` generates drafts to `output/queue/` using Anthropic API. Does NOT post.
- No GitHub→Zapier→LinkedIn pipeline existed.

### New Pipeline (configured this session)
1. Content Strategist writes a post in Mike's voice
2. Pushes markdown file to `mbennett-labs/crawdaddy-automation/linkedin-posts/` via GitHub API
3. File naming: `linkedin-post-YYYYMMDD-HHMMSS.md`
4. **Zapier watches** the `linkedin-posts/` folder for new files (NEEDS MANUAL SETUP — see below)
5. Zapier extracts the file content and posts to LinkedIn

### What Still Needs Manual Setup
1. **Zapier Zap creation** — Go to zapier.com, create a Zap:
   - Trigger: GitHub → New File in Repository
   - Repository: mbennett-labs/crawdaddy-automation
   - Folder: linkedin-posts/
   - Action: LinkedIn → Create Share Update
   - Content: file body text
2. **LinkedIn OAuth** — Connect Mike's LinkedIn account to Zapier
3. Alternative: Use Zapier webhook instead of GitHub trigger — the Content Strategist could POST directly to a Zapier webhook URL

---

## Task Results

| Task | Status | Details |
|------|--------|---------|
| Post 1 pushed to GitHub | YES | `linkedin-posts/linkedin-post-20260330-175816.md` |
| Content Strategist instructions updated | YES | Full voice guide, GitHub push workflow, posting rules |
| Weekly routine created | YES | Routine `a68e273a`, assigned to Content Strategist, Monday 9 AM |
| 3 draft posts written | YES | See below and `C:\Users\mikeb\paperclip\CONTENT_DRAFTS.md` |

### GitHub Post URL
https://github.com/mbennett-labs/crawdaddy-automation/blob/main/linkedin-posts/linkedin-post-20260330-175816.md

### Paperclip Configuration
- Content Strategist Agent: `b5495be0-1843-4169-9629-24cad83e2dac`
- Project: Content Pipeline (`d6bb17a0-3510-4c03-aafb-182e5c44a714`)
- Routine: Weekly LinkedIn Posts (`a68e273a-8c32-460d-a88c-fffe1f81d87c`)
- Schedule: Every Monday at 9 AM (cron: `0 9 * * 1`)

---

## Draft Posts (Full Text)

### POST 1 — PQC Urgency (PUSHED TO GITHUB)

China's quantum computing budget hit $15.3 billion last year. Your encrypted healthcare records have a shelf life of 10+ years. Do the math.

This isn't theoretical. Nation-state actors are intercepting and storing encrypted traffic right now. They can't read it today. They're betting they will by 2028.

NIST finalized three post-quantum standards last August — FIPS 203, 204, and 205. That was the starting gun. Every month you wait, your migration window shrinks while the harvest window stays open.

I run CrawDaddy, a security scanner that checks codebases for quantum-vulnerable cryptography. Last week we scanned 866 files in a single repo and found zero post-quantum protections. Score: 100/100 on our quantum readiness scale. Sounds good until you realize that means they haven't started migrating.

Most organizations don't even know where RSA and ECDSA live in their stack. That's the first problem.

Have you audited your cryptographic dependencies yet, or are you still assuming "encryption = safe"?

#PostQuantum #Cybersecurity #QuantumComputing

---

### POST 2 — CrawDaddy Product (DRAFT — NOT YET PUSHED)

Built a security scanner. It caught something real on day three.

A token called Vespera came through CrawDaddy for a routine smart contract scan. Score: 80 out of 100. One critical finding: the contract owner can mint unlimited tokens. No cap. No multi-sig. One private key compromise and the entire supply gets diluted to zero.

The specific line of code — `_mint(address account, uint256 amount)` at line 230 — sits there with no governance wrapper. No timelock. No DAO vote required.

CrawDaddy found it in 8 automated checks for $0.49. Forty-nine cents. The token had real holders. Nobody had flagged it publicly.

I built this on a t3.small EC2 instance running a Node.js seller on Base L2. Total infrastructure cost: about $15/month. The scanner checks for honeypots, rug pull patterns, concentrated holdings, mint functions, blacklist capabilities, and six other risk vectors.

We're not doing revolutionary AI here. We're doing specific, automated checks that most people skip.

What's the last smart contract you actually read before buying the token?

#DeFi #SmartContractSecurity #Web3

---

### POST 3 — Agent Economy (DRAFT — NOT YET PUSHED)

I run a company with 15 AI agents and zero employees. Revenue comes in while I sleep. Literally.

Here's the stack: Paperclip manages the org chart — CEO agent, Security Engineer, Content Strategist, QA Engineer. Claude Code with --dangerously-skip-permissions gives them hands. They SSH into an EC2 t3.small, run scans, post results, restart crashed processes.

The revenue engine is CrawDaddy on Virtuals ACP. Someone submits a GitHub repo or contract address, pays $0.49 in USDC on Base L2, and the seller agent runs a quantum vulnerability scan autonomously. No human in the loop. Report delivered in under 60 seconds.

Last week I checked the Alchemy dashboard and found three $0.49 payments I didn't know about. The swarm earned money I hadn't noticed.

The part nobody talks about: most of my time is spent fixing the plumbing, not building features. Websocket reconnection logic. Payment watcher API endpoints rotating. Stale PID files. The agents work fine. The infrastructure between them is where everything breaks.

Running a Bittensor SN61 miner on the side. It validates model responses for TAO rewards. Same EC2 box. Same $15/month.

When did you last check if your business model requires you to be awake?

#AgentEconomy #AI #Crypto

---

*Report generated March 30, 2026 by Claude Code*
