# EC2 Status Report
Generated: 2026-03-30

## SSH Connection
- **Status:** SUCCESS
- **Host:** ubuntu@3.20.79.143
- **Key:** C:\Users\mikeb\.ssh\clawdbot-clean.pem

## Seller Process
- **Status:** RUNNING
- **PID:** 4057992
- **Uptime:** 1 day, 22 hours, 15 minutes
- **Command:** `node tsx src/seller/runtime/seller.ts`
- **Location:** `~/.openclaw/virtuals-acp/`
- **Offerings:** security_vulnerability_scan, token_contract_scan

## Bastion Process
- **Status:** RUNNING (tmux session active)
- **PID:** 52296 (tmux session)
- **Log tails active:** Multiple `tail -f` on bastion.log

## Other Services
- **pm2:** Not installed
- **systemd crawdaddy:** No systemd service

## Last 20 Lines of seller.log
```
============================================================
[seller] New task  jobId=1003272120  phase=REQUEST
         client=0x37f7E25c79F385dad476Fde0a078a7411bE1B25B  price=0.01
         context=null
============================================================
[seller] Price too low (0.01) for offering "security_vulnerability_scan" — rejecting
[sellerApi] acceptOrRejectJob  jobId=1003272120  accept=false  reason=Job fee below minimum: $0.49 required.
[socket] Disconnected: transport close
[socket] Connected to ACP
[socket] Joined ACP room
[socket] Disconnected: transport close
[socket] Connected to ACP
[socket] Joined ACP room
[socket] Disconnected: transport close
[socket] Connected to ACP
[socket] Joined ACP room
[socket] Disconnected: transport close
[socket] Connected to ACP
[socket] Joined ACP room
```

## SESSION_HANDOFF.md Contents

**PROJECT NAME: SELARIX** — The Sovereign Fortress

### Active Phase: Phase 1

#### Phase 1 Checklist
- [x] CrawDaddy live on ACP + Moltbook
- [x] EC2 hardened, watchdog running
- [x] SN61 miner registered UID 57
- [x] Miner repo configured, correct active_commit.yaml
- [x] Port 8091 open UFW + AWS SG
- [ ] Miner scoring (first score expected after 14:00 UTC 2026-03-19)
- [ ] handlers.ts deployed
- [ ] CrawDaddy → Chutes inference connected
- [ ] TAO staked in Crucible

#### Agent Status

**CrawDaddy**
- Status: LIVE
- Watchdog: ~/crawdaddy-security/scripts/seller-watchdog.sh (every 15 min)
- Wallet: 0x25B50fEd69175e474F9702C0613413F8323809a8
- Offerings: security_vulnerability_scan, token_contract_scan

**SN61 Miner**
- Status: RUNNING, awaiting first score
- UID: 57 | Container: miner-agent-miner-1 (image 3.0.5-260311)
- Active challenges: ada_detection_v2, dev_fingerprinter_v2

**Bastion V2**
- Status: LIVE — DORMANT (zero credit consumption)
- Service: bastion-v2.service (systemd, enabled)
- Port: 8092

**Autoresearch**
- Status: ACTIVE (cron every 6h)
- Telegram: Daily summary (token needs regen — got 401 on 2026-03-20)

#### Open Blockers
1. Confirm miner scoring after 14:00 UTC
2. Deploy handlers.ts
3. CrawDaddy → Chutes AI inference
4. Crucible staking (~0.11 TAO fee)

#### Last Session (2026-03-27)
- Paperclip live: QSL Security Ops, 4 agents, full blueprint context loaded
- Job drought root causes identified: wrong moltlaunch agent ID (17484→2037)
- moltlaunch poller fixed, crawdaddy-automation pushed to GitHub
- Moltbook down 8+ hours (Meta infrastructure issue)
- Content Strategist posting pipeline needs real openclaw integration
