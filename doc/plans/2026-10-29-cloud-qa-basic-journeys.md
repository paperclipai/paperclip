# Five additional daily Cloud QA journeys

The existing daily QA plan runs three deployment-targeted Product E2E journeys.
Extend it with the five workflows requested in this chat, qualifying every one
against the registered testing Cloud QA instance before promotion. GitHub hosts
the browser driver; the application and native agents remain on Cloud/Daytona.

## Acceptance

| Journey | Required live evidence |
| --- | --- |
| Plan, revise, approve, complete | Persisted canonical Plan, a distinct revision-bound replacement confirmation, browser revision and approval, no premature completion, final native completion. |
| Deliver and revise an artifact | Browser downloads of both versions, independent content validation, different hashes, original download still available. |
| Approve and decline protected actions | Authenticated controlled service, zero accepted invocations before approval, exactly one after approval, zero after decline, saved UI decisions and truthful responses. |
| Create and edit a company skill | Native skill-creation receipt, persisted owned skill, activity card, browser Skill Studio edit, reload and task readback. |
| Stop and redirect | Observed active native work, browser Stop, authoritative retirement of the original work, one saved new-direction message, correct new response, no old work continuing. |

## Ownership and delivery

- Shared Product journey code owns user actions, prompts, assertions and evidence.
- Target adapters own authentication, registered target identity, independent
  fixtures, native agent/connection setup, run accounting and owned cleanup.
- The private Cloud QA workflow owns TestOps selection, upload, reports and Slack.
- Reuse the existing classic story logic and graders where applicable; keep
  deployment-specific setup outside shared stories. Keep local and Cloud target
  selection explicit and fail closed on missing capabilities or evidence.
- Retain unsuccessful attempts. Product grades, infrastructure failures,
  cleanup, usage coverage and trace delivery remain distinct observations.
- Promote each new case to the saved daily TestOps plan only after its real
  Cloud pass, independent evidence inspection and successful cleanup.
- Completion requires all five new journeys passing and present in the daily
  plan, the existing three controls still passing, passing applicable repository
  checks/reviews, and a real combined CI/TestOps/report/Slack verification.

## Feedback path

Calibrate assertions and selectors without paid work first. Qualify a narrow
Cloud case, inspect its retained evidence, then add the other cases. Prefer the
existing protected QA credential and workflow paths; do not weaken source review
or secret boundaries to run candidate harness code. Record configuration,
source revisions, target deployment identity, duration and measured usage.
