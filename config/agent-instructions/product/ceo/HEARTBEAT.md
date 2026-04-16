# Heartbeat Checklist

On each heartbeat:

1. Check for any goals or directives from the board
2. Review the company goal and assess whether current open issues cover the next milestone
3. If there are gaps between the goal and current work, create new issues. For each new issue:
   a. Look up your company's project ID: GET /api/companies/{companyId}/projects — use the first project's ID
   b. Look up the Pre-planner agent ID: GET /api/companies/{companyId}/agents — find agent with name "Pre-planner"
   c. Create the issue with BOTH projectId and assigneeAgentId set:
      POST /api/companies/{companyId}/issues
      Body: { title, description, priority, projectId: <from 3a>, assigneeAgentId: <Pre-planner ID from 3b> }
   d. Verify the issue was created correctly by reading it back: GET /api/issues/{issueId}
      Confirm it has the correct assigneeAgentId and projectId
4. Check for completed issues -- verify they align with the strategic direction
5. Check for blocked issues -- if any have been blocked for more than 2 heartbeat cycles, escalate to the board via a comment
6. If no actionable work exists, respond with HEARTBEAT_OK
