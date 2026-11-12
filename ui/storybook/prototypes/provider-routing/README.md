# Provider routing UI review

Open **AI Connections → Provider routing → 00 Overview → Start here**.
The seven numbered neighboring groups cover onboarding, provider setup, agent
configuration, connection management, and task recovery. Every preview includes
links to the other groups. The overview links to the existing stories reviewed;
the existing AI Connections review index links back here.

Groups 01–05 remain design fixtures: their credentials never reach a real provider.
**06 Production components** renders `AiProviderSetup` and `AiConnectionSelect`
directly from the app with fixture data. The running app now implements connection
routing, encrypted credentials, connection-aware model selection, reconnect, and
runner projection. See [AI Connections](../../../../doc/connections/AI-CONNECTIONS.md)
for the implemented compatibility matrix and validation evidence. Exploratory
Vertex, environment-identity, custom-header, and model-discovery prototypes are
not shipped options; the production group is the implementation reference.
Shared production harness/model pickers also receive presentation improvements:
the existing `AdapterMark` is extracted for reuse, and their triggers share the
`Select` trigger styling for consistent sizing.
Provider choices reuse `ConnectionChoiceList` with its optional icon slot and
the production `AppLogo` renderer. Google and Bedrock marks come from the
[LobeHub static SVG library](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons),
under the existing `ui/public/brands/apps/LOBE-LICENSE`; custom gateways use the
shared network icon. Marks resolve locally through the app brand manifest.

## Existing UI reused

| Surface           | Existing pieces                                                                                                                                                                              | Proposed extension                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Connectors list   | `ConnectorCard` from `pages/apps/Browse`, including its `ConnectionAccountRow`, owner, status, and menus                                                                                     | Provider fixtures; compact account summaries                  |
| Provider setup    | `StepHeader`, `AccessStepContent` (human access and agent picker), `ConnectionChoiceList`, `ProviderApiKeyCard`                                                                              | Provider/endpoint, protocol, AWS/Vertex identity fields       |
| Agent settings    | `AgentSettingsPreview` with the real `AgentContextualSidebar`, breadcrumbs, and page header; `AdapterTypeDropdown`, `ModelDropdown`, `Select`, `AiConnectionLegacyNotice`, `RuntimeTestCard` | Connection-aware model selection and compatibility states     |
| First onboarding  | `ModelSourceTiles`, `CredentialModeLink`, `ConnectionChoiceList`, `ProviderApiKeyCard`                                                                                                       | Optional provider/gateway entry                               |
| Connection detail | `AccessStepContent` and shared form/dialog primitives                                                                                                                                        | Destination summary, model aliases, and credential management |
| Task recovery     | `ConnectionIntentInteractionBody` and its inline Fix connection flow; `ProviderApiKeyCard`                                                                                                   | Gateway-specific credential setup content                     |

**03 Agent is located at Agents → Nova → Harness / Runtime**
(`/agents/nova/runtime`). It renders inside the existing agent settings page;
the proposed controls fill its runtime section. This is not a separate page.
The Connectors story reuses the production provider cards and account rows,
while its new routing detail fields remain a prototype.

## Simple by default

- **Onboarding:** normal subscription/API-key path. The gateway entry is inside
  collapsed **Advanced**. `Happy path walkthrough` completes setup without opening it.
- **Agent:** native Codex/Claude account by default. **Connection** is a dropdown
  between Harness and Model, using the same shared `Select` as Reasoning and
  Execution environment. It lists all saved connections compatible with the harness,
  including configured gateways, and offers **Connect an account…**. Changing
  the harness updates the choices; an incompatible current selection stays visible
  with an error until the user chooses a replacement.
  **Advanced model settings** exposes provider setup and enables manual model IDs.
  Opening or closing it never changes the saved connection/model. Blocking errors
  remain visible. `Configured gateway` shows a previously selected gateway with
  the same compact view; `Connection dropdown` and `Advanced model settings` show
  the expanded surfaces for review. `Change account walkthrough` covers switching
  ordinary accounts, dismissing without a change, focus return, and invalidating a
  previous test. `Harness connection filtering` checks that switching the harness
  updates the available accounts.
- **Add connection:** familiar providers first, with OpenRouter, Bedrock, and
  custom endpoints under **Advanced providers**.
- **Manage:** the default fixture shows ordinary connected accounts. `With advanced
connections` shows a company that already uses gateways. Saved gateways remain
  visible; URLs and protocols live inside **Advanced connection settings** on detail.

Disclosures reuse the production `Collapsible` and `Button` primitives. The story
assertions cover the hidden advanced fields, completing ordinary onboarding,
explicitly opening advanced setup, and preserving a custom selection on collapse.

## Review sequence

1. **01 Onboarding:** current default sign-in shape, saved reuse, and optional
   “Use another provider or gateway” entry under Advanced. Walk through setup into an agent.
2. **02 Connect:** provider → Access → Connect; OpenRouter API key, Bedrock region
   with a Bedrock API key; exploratory environment identity, Google Vertex identity,
   custom Responses/Messages endpoints, custom auth header, and local endpoint.
3. **03 Agent:** harness/connection/model ownership, new and legacy runners,
   model discovery and manual alias, incompatibility, loading/empty/denied states,
   environment-specific tests, read-only, and adoption of existing settings.
4. **04 Manage:** list/detail, credential replacement, endpoint replacement as a
   separate connection, model aliases/metadata, helper default, access, and revoke.
5. **05 Recovery:** expired/missing credential, inline repair, cancellation/focus,
   invalid key retry, protocol mismatch, and quota. Successful inline repair uses
   the existing connection request completion and task continuation flow.

Walkthrough stories execute interactions automatically. Other stories start at
the named state and remain interactive. Navigate to reset fixtures. The recovery
demo rejects the example key `invalid`; other nonempty example keys succeed.
Changing an agent connection preserves its model until an explicit replacement
is chosen. Changing settings invalidates the previous test.

## Scope exclusions

OpenClaw Gateway, Hermes Gateway, Claude Managed, AWS AgentCore, Process, HTTP,
and legacy `acpx_local` are excluded. Remote/custom integrations defer model
choices to their external agent/runtime; `acpx_local` is retired. Claude/Grok's
ACPX-backed new runner and Hermes **local** remain in scope. Cursor's custom
endpoint capability and native Pi/Copilot qualification are shown as boundaries,
not presented as shipped integrations.

## Validation

```sh
pnpm --filter @paperclipai/ui exec storybook dev --port 6143 --host 127.0.0.1 --no-open --ci -c storybook/.storybook
pnpm --filter @paperclipai/ui typecheck
pnpm check:token-gates
pnpm build-storybook
```

The walkthrough stories include interaction assertions. Review all story renders,
walkthrough results, internal links, and representative light/dark mobile layouts
in the browser.

Production Bedrock setup accepts only a Bedrock API key. General AWS access keys
are excluded until a credential broker can contain them. Environment identity,
Vertex, and arbitrary-header stories remain design explorations, not shipped
provider options.
