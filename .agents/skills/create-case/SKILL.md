---
name: create-case
description: Create and kick off a Paperclip case from a user request, with workflow instructions and an initial agent.
---

# Create a Case

Read the [case instructions](../../../skills/paperclip/references/cases.md)
before acting. If this skill is installed outside the checkout, locate the
Paperclip repository and read `skills/paperclip/references/cases.md` there.

Follow that guide to create and kick off the user's case using native
`create_case` or its documented REST equivalent. Include a Mermaid
`stateDiagram-v2` map and prose explaining the transitions in the workflow document.

Return the case and primary task links, together with the accepted kickoff state.
