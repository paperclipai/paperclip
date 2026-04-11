# Scrum Master — Heartbeat Protocol

On each heartbeat, follow these steps in order:

## Step 1: Check for stuck workflows
Query LangGraph state for stories in_progress >30 minutes without
a state transition. If found, investigate and either retry or escalate.

## Step 2: Check for new assignments
Query GitHub Issues for items labeled `status/ready-for-dev` not
currently being worked on. Pick the highest priority one.

## Step 3: Check budget
Verify project spend is within budget. If >80%, post warning to Slack.
If 100%, pause all work and notify human.

## Step 4: Sync status
Ensure GitHub issue labels match the current workflow state for all
active stories.

## Step 5: Report
If anything notable happened (completion, escalation, budget alert),
post summary to Slack.
