---
name: incident-debugger
description: Root cause investigation for production incidents. Log analysis, hypothesis testing, rollback planning, and patch verification. Turns chaos into clarity.
---

# Incident Debugger

Structured protocol for investigating and resolving production incidents. Prioritizes user impact mitigation over root cause perfection. You can always do a thorough post-mortem after the bleeding stops.

## When To Use

- Production is broken and users are affected
- A deploy introduced a regression
- Data looks wrong and you don't know why
- A service is degraded (slow, intermittent failures, partial outages)
- Something changed and nobody knows what

## The Investigation Protocol

### Phase 1: TRIAGE (first 5 minutes)

**Goal:** Understand impact and decide whether to roll back immediately.

Answer these questions fast:
1. **Who is affected?** All users? Subset? Internal only?
2. **What is broken?** Complete outage? Degraded? Wrong data?
3. **When did it start?** Check deploy history, cron logs, external dependency changes.
4. **Is it getting worse?** Stable error rate or escalating?

**Decision point:**
- If users cannot complete critical actions (payments, auth, data access): **roll back first, investigate second.**
- If degraded but functional: investigate before rolling back (rollback might make it worse if the issue is data-related).

### Phase 2: ISOLATE (5-15 minutes)

**Goal:** Narrow the search space.

**Check the usual suspects in order:**
1. **Recent deploys:** `git log --oneline -10`. Was anything deployed in the last 24 hours?
2. **Config changes:** Environment variables, feature flags, third-party API keys.
3. **External dependencies:** Is a third-party service down? Check status pages.
4. **Infrastructure:** CPU/memory spikes, disk full, connection pool exhaustion.
5. **Data:** Was a migration run? Did a batch job corrupt records?

**Log analysis:**
```bash
# Find error spikes
grep -c "ERROR" /var/log/app/*.log | sort -t: -k2 -rn | head -20

# Find the first occurrence
grep "ERROR" /var/log/app/*.log | head -5

# Trace a specific request
grep "request_id" /var/log/app/*.log

# Check for new error types
diff <(grep -o 'Error: .*' old.log | sort -u) <(grep -o 'Error: .*' new.log | sort -u)
```

**Output:** "The issue is in [layer]. It started at [time]. It correlates with [event]."

### Phase 3: HYPOTHESIZE

**Goal:** Form testable hypotheses. Not guesses.

For each hypothesis:
1. **State it clearly:** "The payment webhook is failing because the Stripe API key was rotated but the env var was not updated."
2. **Predict observable evidence:** "If true, I should see 401 errors in the webhook handler logs after [timestamp]."
3. **Test it:** Check the logs/data/code for that specific evidence.
4. **Confirm or eliminate:** Evidence matches = proceed to fix. Evidence contradicts = next hypothesis.

**Common root causes:**
- **Deploy regression:** New code has a bug. Evidence: error timestamps align with deploy.
- **Data corruption:** Bad migration or batch job. Evidence: specific records have impossible values.
- **Config drift:** Env var changed, expired, or missing. Evidence: works in one environment but not another.
- **Dependency failure:** External service changed behavior. Evidence: outbound request logs show new error codes.
- **Resource exhaustion:** Memory leak, connection pool drain, disk full. Evidence: gradual degradation, not sudden failure.
- **Race condition:** Intermittent failures under load. Evidence: errors correlate with traffic spikes, not deploys.

### Phase 4: FIX

**Goal:** Resolve the issue with minimum risk.

**Fix options (in order of preference):**

1. **Rollback:** If a deploy caused it, roll back to the last known good version. Fastest, lowest risk.
2. **Config fix:** If it is a config issue, update the config. No code change needed.
3. **Hot fix:** Minimal code change that addresses the root cause. Must be reviewable in 5 minutes.
4. **Feature flag:** Disable the broken feature while building a proper fix.
5. **Data fix:** If corrupted data is causing errors, fix the data (with a backup first).

**Before applying any fix:**
- [ ] The fix addresses the confirmed root cause (not a symptom)
- [ ] The fix has been tested (locally, staging, or with a dry run)
- [ ] A rollback plan exists for the fix itself
- [ ] The fix does not introduce new risk

### Phase 5: VERIFY

**Goal:** Confirm the fix worked and the issue is fully resolved.

**Verification checklist:**
- [ ] Error rate returned to baseline (check logs/monitoring)
- [ ] Affected user flow works end-to-end (test it yourself)
- [ ] No new errors introduced by the fix
- [ ] Edge cases that triggered the issue no longer reproduce
- [ ] Data integrity confirmed (if data was involved)

**Wait and watch:** Do not declare resolved immediately. Monitor for 15-30 minutes. Some issues are intermittent and appear fixed before recurring.

### Phase 6: POST-MORTEM

**Goal:** Prevent recurrence.

Write a brief post-mortem:

```markdown
## Incident: [one-line description]
**Date:** [when]
**Duration:** [how long users were affected]
**Impact:** [who was affected, what broke]

### Timeline
- [HH:MM] First error observed
- [HH:MM] Investigation started
- [HH:MM] Root cause identified
- [HH:MM] Fix deployed
- [HH:MM] Verified resolved

### Root Cause
[What actually went wrong, traced to the specific line/config/event]

### Fix Applied
[What was changed]

### Prevention
- [ ] [Action to prevent recurrence]
- [ ] [Monitoring/alerting to catch earlier]
- [ ] [Process change if applicable]
```

## Rollback Procedures

### Code Rollback
```bash
# Find last known good commit
git log --oneline -20

# Deploy specific commit
git checkout <commit-hash>
# Then redeploy using your standard process
```

### Database Rollback
```bash
# ALWAYS backup before rolling back
pg_dump -h host -U user dbname > backup_$(date +%Y%m%d_%H%M%S).sql

# Roll back migration
npx prisma migrate resolve --rolled-back <migration_name>
# OR
npm run migrate:down
```

### Config Rollback
Check version history of your env/config files. If using a secrets manager, check the audit log for recent changes.

## Common Pitfalls

- **Fixing symptoms instead of causes.** Restarting a server fixes the symptom. The memory leak that caused the crash is still there.
- **Changing multiple things at once.** If you change the code AND the config AND restart the server, you do not know which fixed it.
- **Declaring victory too early.** Wait 15-30 minutes. Intermittent issues recur.
- **Skipping the post-mortem.** The same incident will happen again. The post-mortem is the only thing that prevents it.
- **Solo debugging for too long.** If you have been stuck for 30 minutes, bring in another set of eyes. Pattern blindness applies to debugging too.
