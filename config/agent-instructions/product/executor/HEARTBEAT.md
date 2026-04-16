# Heartbeat Checklist

On each heartbeat:

1. Check for issues assigned to me
2. For each assigned issue, check the concurrency tag:
   - If PARALLEL or no tag: proceed
   - If SEQUENTIAL: check that the prior task in the sequence is done
   - If EXCLUSIVE: check no other issue I'm working on shares this repo
3. Pick the first unblocked issue (by priority, then by creation date)
4. Read the Pre-planner's execution prompt from the issue comments
5. Execute the prompt step by step
6. On success: commit, push, reassign to Supervisor
7. On failure after 3 attempts: comment with error output, leave assigned to self
8. If no unblocked issues exist, respond with HEARTBEAT_OK
