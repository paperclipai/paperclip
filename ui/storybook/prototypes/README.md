# New agent prototype and onboarding connection stories

Run Storybook:

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6010 --host 127.0.0.1 --no-open -c storybook/.storybook
```

## Existing onboarding

**Onboarding → Agent arc** mounts the shipped `OnboardingWizard` against API
fixtures. The four **Connect · ...** stories walk from naming the agent to the
actual Claude/OpenAI subscription and API-key screens. Claude shows the returned
authorization-code field; Codex/OpenAI shows its device code. They stop at the
connection prompt for visual review. They do not authorize real provider accounts.

**Onboarding → Connect a model** remains the older tile/mode design preview, not
the shipped flow. Use Agent arc to inspect current onboarding behavior.

## New agent

**Onboarding → New agent → Start here · Interactive flow** starts with naming the
agent, selecting an adapter, and simulated creation. Claude and Codex then walk
through Connect → Configure → Confirmation. Other adapters go straight to
configuration. No working directory, instructions, advanced settings, role,
permissions, or scheduling steps are shown.

Paperclip Runner has exactly three choices, selected before creation:

- Codex (app server): the native Codex runner.
- Claude (ACPX): the Claude runner.
- OpenCode: the OpenCode runner.

The adapter and runner stay fixed after creation. Configuration carries the
provider's brand mark and uses the shipped `ModelDropdown` with the adapters'
existing model lists. Every model starts on **Default**. Adapters without a
bundled list show Default until runtime discovery is wired up. Every model picker
also accepts a custom model ID through the shipped dropdown’s creatable option.

Claude and Codex offer subscription or API-key connections, directly and through
their runners. Eight **Connect · ...** stories expose those combinations.
**Connect · Choose subscription or API key** starts before selecting a method.
The connection step reuses `ModelSourceTiles`, `CredentialModeLink`,
`OnboardingLoginCard`, `OnboardingCardField`, `OnboardingLoginCodeRow`,
`OnboardingCard`, `OnboardingHeading`, and `FooterNav`, plus the existing
onboarding motion constants for the source collapse, card reveal, button labels,
and connecting hold. Only the already-selected provider is offered.

The provider lifecycle is simulated locally. Use example keys/codes. Claude
accepts a pasted code or Enter; Codex has a separate **Simulate completed sign-in**
preview control. No keys or codes are persisted or sent to a provider. Completion
advances to configuration. Direct configuration and confirmation stories seed a
completed connection so each screen can be reviewed independently.

**06 · Confirmation** and **Confirmation · Native Codex runner** expose the final
screen directly. Finish setup reaches that screen interactively; Edit configuration
preserves the choices, and Start over clears them.

These stories remain isolated design fixtures. The production implementation now
lives in `ui/src/components/new-agent/`, with real hiring, subscription login,
secret storage, provider probes, and task assignment. OpenCode and Pi support
provider environment variables, including saved OpenRouter secrets. The real
configuration page uses the same compact test card and shared settings styles.
See `docs/specs/agent-config-ui.md` for the current workflow. Environment choices
in Storybook remain fixtures.

## Configuration checks and task assignment

The numbered sidebar shows Connect (where supported), Configure, and Confirmation.
Model and thinking-effort labels use the same `Field` component; their controls
share padding, line height, and border sizing. Environment has one section label.

**Test** invokes the existing `agentsApi.testEnvironment` client with the selected
adapter, model, effort, runner provider, and environment. Story-scoped fetch
fixtures return the configured result after a short delay, and `RuntimeTestCard` presents the result in a shared neutral surface. Each state
has one status icon, a short summary, and an action in the same position.
Individual checks and remediation hints remain available under **Test details**. These are simulated runtime probes;
no provider process runs. The **Test · Succeeded**, **Failed**, **Running**, and
**Retry after failure** stories expose each state. Storybook controls choose the
outcome and latency. A failed test prevents finishing until settings change or a
retry succeeds. Changing settings clears stale results; leaving the story or
starting over invalidates pending responses.

**Assign <agentName> a Task** opens the shipped `NewIssueDialog` with this story’s
agent ID as assignee. A scoped agent fixture provides the matching display name.
Task submission is also intercepted locally and displays a confirmation without
persisting a real issue. Fixture overrides and the temporary agent cache entry
are cleaned up on unmount.


## Full agent configuration review

**Agents / Configuration refresh** covers Overview, Instructions, Skills,
Harness / Runtime, Secrets & variables, Tools, Permissions / Trust, API Keys, and Revisions.
Additional runtime stories cover Codex, OpenCode, Pi, and Paperclip Runner, plus
interactive test-failure and save-failure fixtures.

This preview composes the existing `AgentContextualSidebar`, `AgentOverview`,
`PromptsTab`, `AgentSkillsTab`, `AgentConfigForm`, `AgentToolsTab`, permission
controls, key management, revision history, and `AgentActionButtons`. The file
editor and skills interactions are unchanged. Runtime sections are ordered by
optional form presentation props and shared scoped styles for spacing and
aligned fields. The real agent configuration pages now use this same presentation.

Mutable fixtures support configuration saving, file editing/creation/deletion,
skill changes, secret bindings, tool installation, permission changes, key
creation/revocation, pause/resume, and revision restoration. Runtime tests use the
real form action and API client with a simulated response. Saves and remote
operations do not reach a live server. Linked audit, tool-management, and task
pages are outside this configuration preview; unhandled mutations show an
explicit fixture error. Switch stories to reset the example data.

The configuration header uses the onboarding `PillGuy` avatar and omits the manual
heartbeat action and status badge. The unified **Secrets & variables** tab uses a
single `AgentConfigForm` draft for environment bindings and API-access grants, so
Save and Discard apply to both together. Variable bindings no longer appear on
Harness / Runtime. Routine next-run notices are omitted in this review layout.
