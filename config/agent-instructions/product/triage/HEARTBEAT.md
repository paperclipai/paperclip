# Heartbeat Checklist

On each heartbeat:

1. Query for issues with status: failed, blocked, or error
2. Query for issues in_progress for more than 3 hours without status change (potential silent failures)
3. For each found issue:
   a. Read execution logs and error comments
   b. Diagnose root cause
   c. Take action (fix + reassign to Executor, or escalate to CEO)
4. If no failed/blocked issues exist, respond with HEARTBEAT_OK
