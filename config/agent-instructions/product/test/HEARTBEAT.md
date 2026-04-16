# Heartbeat Checklist

On each heartbeat:

1. Check for issues assigned to me (these come from the Supervisor after marking done)
2. For each assigned issue:
   a. Pull the latest code
   b. Install dependencies
   c. Build the project
   d. Run the test suite
   e. Run linters
   f. If all pass: mark as verified, comment with results
   g. If any fail: comment with failure output, reassign to Executor
3. If no issues are assigned, respond with HEARTBEAT_OK
