# Use a saved assigned skill

`saved-skill-use` is a reusable Product E2E journey for an existing target. It
uses one native work run on the target provider's campaign-owned agent. It does
not enroll itself in a daily plan. Local calibration and catalog discovery are
separate from a real staging pass.

The target supplies ordinary company skill-write access. Assignment uses
`desiredSkills: [canonicalSkillKey]`, which selects Latest and returns a stored
`versionId: null`. This path works with Beta skills disabled. No experimental
setting is read or changed. Experimental version pins need separate qualification.

The fixture creates one synthetic company skill through the public skill API.
The journal name, API name and Markdown frontmatter name equal its slug. Each
contains the exact campaign ID, including its hyphens. Recovery can therefore
find the persisted skill by name if a successful creation response is lost.
It assigns the skill on the owned agent through the normal skill sync API.
The created skill must be managed, with the exact canonical company key. Its
creation receipt and separate reads must agree on the immutable current version.
A version read must return the exact `SKILL.md` bytes. The skill's
random receipt reference and two numeric inputs occur only in those saved bytes.
The slug and task prompt do not contain the reference. The task is created
through the production browser composer and explicitly names that skill.

A pass requires all seven closed checks:

- `saved-skill-assignment-bound`: exact company, managed skill, creation version,
  source bytes and one ordinary Latest assignment before dispatch. The successful
  run must have `contextSnapshot.skillSelectionSnapshot: true` and an admitted
  `skillVersions[canonicalSkillKey]` equal to that immutable created version.
- `saved-skill-input-only-in-source`: the persisted request names the skill but
  does not expose its receipt reference; no human comment supplies that reference.
- `saved-skill-native-read-attributed`: a complete successful native skill load or
  source-file read, with start/completion identity bound to this company, agent,
  run, turn and runner. Its native receipt must contain or cryptographically
  commit to the complete saved procedure.
- `saved-skill-result-authored-by-run`: exactly one saved task document contains
  the reference and independently calculated sum. Its revision belongs to the
  successful native run and agent, without human authorship. The run's
  authoritative `nativePhase` must be `committed` before the result qualifies.
- `saved-skill-result-reopened`: the browser reload shows that document, and its
  independently read content and revision are unchanged.
- `saved-skill-source-preserved`: the original skill version, source bytes and
  assignment remain unchanged after execution.
- `configured-model-and-environment`: the one successful run matches the owned
  company, task, agent, configured native provider/model and execution environment.

The read oracle accepts a completed built-in file read with the exact skill
directory target, or OpenCode's native `skill` load with its exact named
`skill_content` wrapper. Deployed OpenCode can instead report a native `read`
with an unknown operation and null target. That path requires its complete file
result wrapper: the file path must name the exact materialized skill directory.
Both the saved assignment entry and the admitted native execution input must
bind that runtime name to the same canonical key and immutable created version.
The file read must remain read-only, successful, paired by call/turn/runner,
untruncated and byte-complete, and its content must contain the full procedure.
A targetless filesystem read without this bound file wrapper cannot qualify. Discovery,
shell output, model prose, failed or truncated reads, foreign run receipts and
marker-only output cannot pass.

Core's native OpenCode proxy forwards its built-in `skill` loader without an
operation. Core records that receipt as `unknown` with a false read-only hint.
This closed loader path requires the actual OpenCode run, runner, native session,
turn, item and paired call. Both assignment records and the admitted version map
must bind the exact immutable skill and materialized directory. Its complete
`skill_content` wrapper and heading must name that skill. The saved procedure
body must match exactly. The local base-directory path must be absolute and name
that bound runtime directory without traversal or URI encodings, and `skill_files`
must be empty. The receipt must be successful, untruncated and byte-complete.
Other unknown operations, raw dynamic calls and unbound loaders still fail.

The first-party `paperclip_read_assigned_skill` tool can also supply the read.
Its complete `inputText` result must contain the exact canonical skill key,
immutable created version, `SKILL.md` path, original Markdown, byte size and
SHA-256 checksum. `nextOffset` must be null. The same dual assignment and
admitted canonical key/version binding is required for every native provider.
The OpenCode materialized directory name is required only for its filesystem
wrapper; it is not a condition for the common first-party semantic read.
A semantic read failure can have a
completed tool status; it does not qualify. A partial page, copied tool result,
foreign version, missing start or unbound native event also fails closed.

Codex's dynamic tool display is not first-party authority. Its raw name,
optional namespace or read-only hint cannot qualify a read. For Codex, the
grader also accepts Core's retained `semantic_tool.input` and `semantic_tool.result`
for the closed read-only operation `read_assigned_skill`. Both must name the
actual run's runner, native session, call, turn and item. The input must match
its own digest and select the canonical skill or its exact admitted alias,
`SKILL.md` and offset zero (including Core's defaults). The successful
`active_task` result must commit to the exact complete immutable read object:
canonical key, version, file, all UTF-8 source text, SHA-256, byte size and a
null next-page offset. The digest uses Core's canonical JSON key ordering.
Missing, duplicate, reordered, failed, foreign or differently hashed carriers
fail. This path does not relax the existing OpenCode built-in or filesystem guards.

The existing campaign deadline bounds observations. Only failed read transport
operations can be retried; task input, skill creation and execution are not
replayed. Done status and a successful run alone cannot qualify incomplete native
finalization. The optional `resultJson.finalizationPhase` presentation field is
not required or accepted in place of `nativePhase`; compact or null result data
can qualify when the authoritative phase is committed.
The provider journals skill and task ownership before creation, then
collects evidence and stops/cleans only campaign-owned resources. The fixed skill
source, native events and saved document receipts stay in the private bundle.
The public report uses the existing closed checks and authenticated task capture.

No instance-wide experimental setting, shared source agent, global model,
company budget or production workspace is changed by this journey.
