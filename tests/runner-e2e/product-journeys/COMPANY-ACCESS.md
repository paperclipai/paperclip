# Company access isolation

`company-access-isolation` checks a deployment that exposes two separately
owned workspaces through its Cloud account organization switcher. The target
provider supplies the `CompanyAccessFixture` contract. A provider without that
capability reports the case as unsupported.

The browser uses the mounted tenant account switcher to open the secondary
workspace and return to the primary workspace. It clicks an observed entry link
for the exact registered slug or ID. Each workspace must return its own single
company and exact owned read sentinel after reload.

A real company-scoped agent credential in each workspace reads its own sentinel
and creates one new task through `POST /api/companies/:companyId/issues`. The
response must be 201. Independent owner reads must show zero matching tasks
before and exactly one afterward, with the exact title, body and company. Both
the response and canonical task must name the actual `createdByAgentId` and a
null `createdByUserId`. The task stays unassigned in Backlog. This is task
creation coverage; task edits and comments require a real heartbeat run and are
not used as zero-run write controls.

The same credential then attempts to read the real foreign sentinel and create
a distinct task in the foreign company through the same POST path. Both actions
must return 401 or 403. The foreign sentinel must stay unchanged, and the
attempted task must not exist. Denied bodies must not expose protected foreign
sentinel content. Echoes of the caller's distinct attempted input are not leaks.
Both directions must pass, including a secondary-issued key rejected by the
primary target. A 404, redirect, transport error, missing creator evidence or
failed allowed control cannot qualify the boundary. This checks company-scoped
agent identity; it does not establish human membership-role policy.

The secondary credential belongs to a disposable HTTP-adapter agent paused
before key creation. It has no model connection, no model budget and no scheduled
heartbeat. The case requires zero task and secondary-agent heartbeat runs. It
compares complete, settled primary-agent history snapshots and rejects any new
primary run, including work outside the owned tasks. A busy or incomplete
primary baseline cannot qualify. The list API omits native retry state, so each
historical run must also have a readable detail receipt with a settled native
phase (or explicit legacy state). Persisted run revisions and lifecycle timestamps
must remain unchanged, including when work resumes under an existing run ID.
Saved passes also reject collected runs or
nonempty model usage. Credentials
stay private to the provider. Both keys must be revoked, and each old key must
return 401 on a previously successful read. Cleanup terminates the owned
secondary agent and retains only cancelled owned task history.

A dedicated secondary workspace can persist between campaigns. Its read
sentinel, created tasks, attempted writes, agent and keys remain campaign-owned.
Exact intents are durable before POST, and lost receipts reconcile through
owner reads without replaying creation. The provider holds a separate secondary
fixture lease and preserves the primary stack lease. Evidence and cleanup must
be confirmed before lease release. Registration, assertion calibration and
fixture setup do not establish a deployed pass or daily-plan admission.
