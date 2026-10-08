# Runner defaults: staged delivery

Updated 2026-10-08.

## Outcome and ownership

Users choose a harness. New agents use Paperclip Runner where the harness and
execution target are qualified. Existing agents keep their recorded runner.
The task owns implementation, verification, review fixes, and reviewable PRs.
Merging and deployment require separate authorization.

The original implementation is preserved on `codex/default-agent-runner` at
`171d841295808ca185a258aaeb10b3dee68bb2b9`. Its public review is
[PR #15422](https://github.com/paperclipai/paperclip/pull/15422).
The user approved splitting that work into four useful steps:

1. Packaged runtime reliability and Codex prerequisites, without changing defaults.
2. Codex defaults across creation, onboarding, hiring, imports, and the UI.
3. Claude defaults and authentication.
4. The remaining supported harness defaults and provider-specific fixes.

## Current slice

Canonical branch: `codex/runner-packaging-prerequisites`.
Frozen master base: `1881894973a2b25838d8abed9bd8aeebc3af4441`.
Canonical PR: [#15555](https://github.com/paperclipai/paperclip/pull/15555).
Its [checks](https://github.com/paperclipai/paperclip/pull/15555/checks) and
[commits](https://github.com/paperclipai/paperclip/pull/15555/commits) record the
final candidate. Hosted results and review disposition belong to that exact
candidate; earlier green checks do not qualify a later revision.

The user requested a smaller PR on 2026-10-08. This slice now covers Codex
executable resolution, native-free npm packaging, the installed JavaScript
dependency graph, and the sandbox resource lookup required by that npm layout.
It retains focused tests and extends the existing public npm consumer verifier.
It does not add a workflow, change Docker or Git installation, change shared
login HOME or working-directory behavior, or transfer runner release assets.
Agent defaults, saved runner choices, UI, schema, and provider qualification stay
unchanged.

The broader prerequisite implementation is preserved on the pushed branch
`codex/runner-packaging-full-snapshot` at
`6f3060beaa842ffcee21af058370d3cab5f571e9`. Its Git staging, extra login isolation,
release pipeline, Docker materialization, and unrelated test-fixture changes
remain outside this PR. Release and platform packaging must be qualified in a
separate slice before enabling new-agent defaults.

### Retained behavior

Ordinary native Codex startup, direct evals, and browser login prefer the
installed dependency. They accept usable older or newer CLI versions. If the
dependency is absent, use the selected host's PATH. Explicit commands and recorded
sessions retain precedence. Real protocol/login failures remain actionable;
there is no silent runner fallback. Release pins and the separate ACPX artifact
qualification stay unchanged. Linux ARM64 keeps its existing legacy login path.

Final review found a relative PATH regression in the retained resolver. Resolve
relative and empty PATH entries against the selected provider working directory;
retain installed-dependency preference. Extend the existing fresh-process fixture
and qualify the resulting commit separately from the green `cb5948e` candidate.

Paperclip npm tarballs retain the patched JavaScript graph and strip Codex native
payloads. The published server declares official optional host packages. npm
installs them for the consumer's OS and architecture. This avoids collisions with
the legacy adapter's separate Codex version. The server owns the bridge dependency
used by its vendored runner. Sandbox reads remain confined to the selected native
vendor resources; package identities and path containment still apply.

Browser login keeps master's provider-specific credential directories, ambient
HOME, and working directory. Only executable selection and safe errors change.

## Evidence and gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Preserve original and broader work | Passed | Pushed branches and revisions above |
| Narrow scope against current master | Passed | Installed Codex/npm scope only; no workflow, Docker, Git installer, or unrelated fixture diff |
| Focused packaging and installed-consumer controls | Passed | 24 packaging tests with actual offline npm tarballs; 9 existing consumer assertion tests |
| Login controls after narrowing | Passed | 13 existing tests; HOME/config-directory/spawn semantics match frozen master |
| Codex selection, protocol, sandbox, and ACPX integrity | Passed locally | 21 selection/security/transport/eval tests; 4 npm layout integrity controls; runner TypeScript no-emit |
| Full checks and fresh review | Pending for relative PATH fix | `cb5948e` passed all 47 CI jobs and its clean Linux npm consumer; qualify the final fix with new CI and fresh 5/5 review |
| Previous broad candidate | Historical | 47 ordinary CI jobs passed at `6f3060b`; not proof for the narrowed candidate |
| Existing old CLI protocol proof | Historical | Official Codex 0.156.1 completed startup handshake; scope must be matched to retained sources |
| All-harness live onboarding and cloud qualification | Deferred | Later defaults slices; authentication probes and CI cannot close live journeys |

Use Node 24 and one worker for focused local checks. Keep heavy builds in hosted
CI. Do not build Docker images or Rust locally. Do not author a lockfile change.
No provider-backed runs or new disposable environments are needed for this
prerequisite slice. Incremental provider spend for narrowing is $0. The original
$250 ceiling and cleanup obligations remain for later live qualification.
Existing credentials and user previews remain untouched.

Next action: commit and push the narrowed candidate, rerun its checks and fresh
review, then update the PR and existing evidence report. Start the Codex-default
slice after the user chooses to proceed. Merging and deployment remain outside
this task.
