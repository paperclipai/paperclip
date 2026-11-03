# Use a saved assigned skill

`saved-skill-use` is a reusable Product E2E journey for an existing target. It
uses one native work run on the target provider's campaign-owned agent. It does
not enroll itself in a daily plan. Local calibration and catalog discovery are
separate from a real staging pass.

The fixture creates one synthetic company skill through the public skill API.
It pins the returned version on the owned agent through the normal skill sync
API. A separate version read must return the exact `SKILL.md` bytes. The skill's
random receipt reference and two numeric inputs occur only in those saved bytes.
The slug and task prompt do not contain the reference. The task is created
through the production browser composer and explicitly names that skill.

A pass requires all seven closed checks:

- `saved-skill-version-pinned`: exact company, skill, version, source bytes and
  agent assignment before dispatch.
- `saved-skill-input-only-in-source`: the persisted request names the skill but
  does not expose its receipt reference; no human comment supplies that reference.
- `saved-skill-native-read-attributed`: a complete successful native skill load or
  source-file read, with start/completion identity bound to this company, agent,
  run, turn and runner. The output must contain the complete saved procedure.
- `saved-skill-result-authored-by-run`: exactly one saved task document contains
  the reference and independently calculated sum. Its revision belongs to the
  successful native run and agent, without human authorship.
- `saved-skill-result-reopened`: the browser reload shows that document, and its
  independently read content and revision are unchanged.
- `saved-skill-source-preserved`: the original skill version, source bytes and
  assignment remain unchanged after execution.
- `configured-model-and-environment`: the one successful run matches the owned
  company, task, agent, configured native provider/model and execution environment.

The read oracle accepts a completed built-in file read with the exact skill
directory target, or OpenCode's native `skill` load with its exact named
`skill_content` wrapper. The provider must expose enough evidence for one of
these paths. A generic read whose target is omitted does not establish which
file was read. Discovery, shell output, model prose, failed or truncated reads,
foreign run receipts and marker-only output cannot pass.

The existing campaign deadline bounds observations. Only failed read transport
operations can be retried; task input, skill creation and execution are not
replayed. The provider journals skill and task ownership before creation, then
collects evidence and stops/cleans only campaign-owned resources. The fixed skill
source, native events and saved document receipts stay in the private bundle.
The public report uses the existing closed checks and authenticated task capture.

No instance-wide experimental setting, shared source agent, global model,
company budget or production workspace is changed by this journey.
