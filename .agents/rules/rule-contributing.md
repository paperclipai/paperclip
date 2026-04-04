---
trigger: model_decision
description: Whenever preparing a walkthrough, pull request, or final hand-off
---

# Rule: Contribution Standards

Ensure that every contribution to Paperclip is clear, well-documented, and easy to review.

- **Activation**: `Model Decision` (whenever preparing a walkthrough, pull request, or final hand-off)

## Guidelines

- **Thinking Path**: Include a clear "Thinking Path" at the top of every PR/Walkthrough summarizing the goal and implementation rationale.
- **Visual Proof**: For any UI or behavioral changes, include "Before" and "After" screenshots or recordings.
- **Manual Verification**: Provide detailed notes and specific commands used for manual verification.
- **Small, Focused Changes**: Favor many small, targeted PRs over one massive PR. Each PR should address one logical change.
- **Standard PR Message**: Beyond the Thinking Path, describe what was done, why it matters, the benefits, and any potential risks.
- **Greptile & Lint**: Ensure all automated checks (Greptile comments, linting, tests) pass before claiming a task is done.
