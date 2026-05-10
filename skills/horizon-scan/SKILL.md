# Horizon Scan Skill

> Always-on CEO monitoring. Run these 4 scans in sequence whenever you wake with
> `PAPERCLIP_WAKE_REASON=self_wake` and `reason=horizon_scan`.
> Skip Scan 4 when env var `HS_SKIP_MEMORY_SCAN=true`.
> After all scans complete, self-wake in 15 minutes (unless `HORIZON_SCAN_ENABLED=false`).

---

## Entry Guard

Before starting, check the kill switch:

```bash
# Global kill switch (env var overrides DB)
[ "$HORIZON_SCAN_ENABLED" = "false" ] && exit 0

# Per-agent DB toggle (read from agent_horizon_config)
curl -s "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
# If horizon scan is not enabled for this agent, exit
"
```

If `agent_horizon_config.enabled = false` for this agent, post no comment and self-wake at the normal interval.

---

## Scan 1 — Active P0/P1 Check

```
1. GET /api/companies/{companyId}/issues?priority=critical,high&status=in_progress,todo,blocked&limit=50
   Headers: Authorization: Bearer $PAPERCLIP_API_KEY

2. For each issue:
   - Compute hours since updatedAt
   - P0 (critical): stalled > p0_stall_hours (default 4h) → ANOMALY:P0_STALLED
   - P1 (high):     stalled > p1_stall_hours (default 24h) → ANOMALY:P1_STALLED
   - If status=blocked AND any blockedBy[].status=blocked → ANOMALY:BLOCKER_CHAIN

3. Output JSON:
   { "scan": "p0_p1", "anomalies": [...], "scanned": N }

4. Actions:
   P0_STALLED  → POST /api/issues/{id}/comments
                  body: "[URGENT] CEO Horizon Scan: P0 issue stalled >Xh，请立即更新状态。"
   P1_STALLED  → POST /api/issues/{id}/comments
                  body: "[NOTICE] CEO Horizon Scan: P1 issue stalled >Xh，请更新进度。"
   BLOCKER_CHAIN → POST /api/companies/{companyId}/issues
                  title: "[URGENT] Blocker chain 解除 — issue {id}"
                  assigneeAgentId: {cto_agent_id}
                  parentId: (optional context issue)
```

**Idempotency key per action:** `P0_STALLED:{issueId}` / `P1_STALLED:{issueId}` — do not repeat within 24h.

---

## Scan 2 — Outstanding Asks > 30min

```
1. GET /api/companies/{companyId}/issues?status=in_review&limit=100

2. For each issue:
   - Compute minutes since updatedAt
   - If assigneeUserId is set (waiting on board) AND idle > board_wait_escalate_minutes (60min)
     → ANOMALY:BOARD_WAIT_LONG
   - Else if idle > outstanding_ask_minutes (30min)
     → ANOMALY:REVIEW_STALLED

3. Output JSON:
   { "scan": "outstanding_asks", "anomalies": [...], "scanned": N }

4. Actions:
   REVIEW_STALLED  → POST /api/issues/{id}/comments
                      body: "[HORIZON SCAN] 本 issue in_review 超过 Xmin 无互动，请 reviewer 反馈。"
   BOARD_WAIT_LONG → Feishu DM to board (via platform-ops):
                      POST /api/agents/me/self-wake with payload.feishu_dm_message
                      or POST /api/companies/{companyId}/issues (notify task to platform-ops)
```

**Idempotency key:** `REVIEW_STALLED:{issueId}` / `BOARD_WAIT_LONG:{issueId}`.

---

## Scan 3 — Engineer Utilization (3-level alert)

```
1. GET /api/companies/{companyId}/agents
   Filter to engineer-role agents only.

2. For each engineer agent:
   a. GET /api/companies/{companyId}/issues?assigneeAgentId={id}&status=in_progress,in_review,blocked

   b. Compute stalledHours per issue (hours since updatedAt)

   c. FULLY IDLE (zero active issues):
      → ANOMALY:ENGINEER_IDLE
      → Action: POST comment on VOG-2922
        body: "CEO horizon scan {date}: {name} 当前无 active issue，可分配新任务"

   d. LEVEL-3 (any in_review issue stalled > engineer_review_zombie_hours = 72h):
      → ANOMALY:REVIEW_ZOMBIE_72H per issue
      → Action: POST /api/issues/{id}/comments
        body: "[REVIEW-ZOMBIE] 本 issue in_review > Xh，请决定: ship 还是重开 in_progress"

   e. LEVEL-2 (ALL active issues stalled >= engineer_stall_l2_hours = 48h):
      → ANOMALY:ENGINEER_ALL_STALLED_48H
      → Actions (parallel):
        (a) Feishu DM (via platform-ops): "⚠️ {name} 全部 N 个 active issue stalled ≥48h，请介入"
        (b) POST /api/companies/{companyId}/issues
            title: "[URGENT] {name} 全部 issue stalled 48h+"
            assigneeAgentId: {cto_agent_id}

   f. LEVEL-1 (any active issue stalled > engineer_stall_l1_hours = 24h, not already at LEVEL-2):
      → ANOMALY:ENGINEER_ISSUE_STALLED_24H per stalled issue
      → Action: POST /api/issues/{id}/comments
        body: "[URGENT] CEO Horizon Scan {date}: 本 issue 超过 Xh 无更新，请更新进度或标 blocked\n[@{name}](agent://{agentId})"
        (The @mention triggers issue_comment_mentioned wake automatically — no separate wake needed)

3. Output JSON:
   {
     "scan": "engineer_utilization",
     "engineers": [{ "agentId": "...", "name": "...", "activeIssues": N,
                     "stalledIssues": N, "maxStalledHours": H, "anomalies": [...] }],
     "totalAnomalies": N
   }
```

**Idempotency key:** `{ANOMALY_TYPE}:{issueId|agentId}`.

---

## Scan 4 — Memory Violations

> Skip entirely when `HS_SKIP_MEMORY_SCAN=true`.

```
1. Run memory_check_prompt_v1 (from VOG-5786 Fix 1):
   - Reads D:\claude-c\.claude\projects\...\memory\MEMORY.md
   - Checks each memory entry for violations

2. Collect violations array

3. For each violation:
   → ANOMALY:MEMORY_VIOLATED
   → POST /api/companies/{companyId}/issues
     title: "[MEMORY] Memory violation 修正 — agent {agentId}"
     assigneeAgentId: {violating_agent_id}

4. Output JSON:
   { "scan": "memory_violations", "violations": [...], "anomalies": N }
```

---

## Self-Wake (End of Scan)

After all 4 scans complete, schedule the next scan:

```bash
INTERVAL=${HS_INTERVAL_SECONDS:-900}

curl -X POST "$PAPERCLIP_API_URL/api/agents/me/self-wake" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"delaySeconds\": $INTERVAL,
    \"reason\": \"horizon_scan\",
    \"idempotencyKey\": \"hs-$(date -u +%s)\"
  }"
```

If any scan found anomalies, also log a brief summary line as a comment on the relevant issue or a self-note.

---

## Circuit Breaker

Stop scanning and create an incident issue if:
- Same agent woken by horizon scan > 5 times within 1 hour → wake storm
- Single scan token cost > 15,000 tokens → overrun
- False positive rate for 2 consecutive days > 30% → accuracy fault

Create incident: `POST /api/companies/{companyId}/issues` with title `[INCIDENT] Horizon scan circuit breaker tripped`, assignee = CTO.
