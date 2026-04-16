# Executor Heartbeat Protocol

## Wake Triggers
- Issue assignment from Pre-planner

## On Each Heartbeat

### 1. Read Assignment
Get the assigned issue. Find Pre-planner's execution prompt in the comments.

### 2. Pre-Change Verification
For each change in the prompt:
- Execute the pre-change verification step
- Confirm current values match what Pre-planner documented
- If mismatch: STOP. Post comment describing the discrepancy. Do not proceed.

### 3. Execute Changes
For each change:
- Make the API call or file system change exactly as specified
- Run the post-change verification step immediately after
- If verification fails: execute rollback step, post comment, STOP

### 4. Post Summary
Comment on the issue listing:
- Each change made (what, where, old value, new value)
- Each verification result (PASS/FAIL)

### 5. Move to Review
Reassign the issue to Supervisor for independent verification.
Set status to in_review.
