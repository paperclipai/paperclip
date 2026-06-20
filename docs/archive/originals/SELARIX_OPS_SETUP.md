# SELARIX Operations — Paperclip Setup Report

**Date:** March 30, 2026
**Blueprint:** QSL Blueprint v3.1 — Claude Code Integration Edition

---

## Company

| Field | Value |
|-------|-------|
| Company Name | SELARIX Operations |
| Company ID | `11dc08e7-2135-4c0f-a605-034285555d8e` |
| Issue Prefix | SEL |
| Status | Active |
| Description | Swarm monitoring division of Quantum Shield Labs LLC |
| Dashboard | http://localhost:3100/SELARIX/dashboard |

## CEO Agent

| Field | Value |
|-------|-------|
| Agent Name | CEO |
| Agent ID | `cb09ca53-87e0-42b3-bc27-79984a0f047e` |
| Role | ceo |
| Title | CEO - Swarm Monitor & Infrastructure Intelligence |
| Command | claude |
| Extra Args | --dangerously-skip-permissions |
| Skip Permissions | true |
| Model | claude-sonnet-4-6 |
| Max Turns | 300 |
| Heartbeat Interval | 86400 sec (24 hours) |
| Instructions Updated | YES — full v3.1 with QSL_CONFIG.md reference, EC2 IP, Three Laws |

## Environment Variables / Secrets

| Variable | Value | Status |
|----------|-------|--------|
| SSH_KEY | C:/Users/mikeb/.ssh/clawdbot-clean.pem | SET (company secret `8b5471cf`) |
| EC2_HOST | ubuntu@3.20.79.143 | SET (company secret `e8bf9c65`) |

## Daily Routine

| Field | Value |
|-------|-------|
| Routine ID | `f08dcab4-f68e-467f-ac3c-721e41b4d739` |
| Title | Daily Swarm Health Check |
| Assigned To | CEO (`cb09ca53`) |
| Project | Swarm Monitoring (`fcbd0741`) |
| Status | Active |
| Schedule | Daily (heartbeat-driven, 24h interval) |

## First Heartbeat Result

| Check | Result |
|-------|--------|
| SSH to EC2 | SUCCESS |
| Seller process | UP — PID 334242, uptime 50 min |
| Bastion process | UP — tmux session active (PID 52296) |
| ACP connection | Connected, joined room, zero errors |
| SESSION_HANDOFF.md | Read successfully — Blueprint v3.1 deployed |
| Telegram message sent | YES — delivered to chat ID 6712910089 |
| Message format | SELARIX Daily — 2026-03-30 with full status |

## Standing Issue

| Field | Value |
|-------|-------|
| Issue ID | `5ae02ad0-617e-42dd-a64a-e053387e5076` |
| Identifier | SEL-1 |
| Title | Daily Swarm Health Check |
| Priority | High |
| Status | Backlog (needs manual assignment via UI) |

---

*Setup completed March 30, 2026 by Claude Code*
*QSL Blueprint v3.1 | SELARIX Operations — First heartbeat confirmed*
