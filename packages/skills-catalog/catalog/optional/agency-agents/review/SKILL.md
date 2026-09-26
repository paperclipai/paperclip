---
name: "review"
description: "Review code changes with the Bugbot or Security Review subagent."
disable-model-invocation: true
key: "paperclipai/optional/agency-agents/review"
recommendedForRoles:
  - "engineer"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "security"
  - "review"
defaultInstall: false
---
# Review

Ask the user which review to run with the AskQuestion tool. If the AskQuestion tool is not available, ask the user directly. Provide exactly one single-select question with two options:

- `bugbot`: Bugbot (`/review-bugbot`)
- `security`: Security Review (`/review-security`)

After the user chooses, run the matching review once:

- Bugbot: follow the `/review-bugbot` instructions.
- Security Review: follow the `/review-security` instructions.
