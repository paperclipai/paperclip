# AI Connections — Storybook review milestone

Status: UI review approved. The app integration is implemented; see [AI Connections](../connections/AI-CONNECTIONS.md) for contracts, runtime selection, adoption, and verification.

## Start here

- [Existing Connectors page with AI accounts](http://localhost:6116/?path=/story/ai-connections-review--provider-catalog)
- [Account details in the existing page](http://localhost:6116/?path=/story/ai-connections-review--management)
- [Add account through the existing setup flow](http://localhost:6116/?path=/story/ai-connections-review--connect-from-existing-catalog)
- [Existing inline task connection host](http://localhost:6116/?path=/story/ai-connections-review--inline-task-connection)
- [Review index](http://localhost:6116/?path=/story/ai-connections-review--review-index)

The old `provider-catalog` URL is retained so links still work. It now renders the real `Browse` page, with AI accounts alongside GitHub and Gmail. It is not another product screen or another provider catalog.

Build and serve with `pnpm build-storybook` and `node scripts/serve-storybook-static.mjs --port 6116`. Alternatively run `pnpm storybook` on its normal development port.

The agent picker omits the personal-account inventory and its default/authorization actions. It retains the responsible-user default preview and compatible shared or already-authorized selections. **Change Personal Default** now exercises the existing account detail page; **Authorize Personal** isolates the owner-consent dialog.

Account details are deliberately compact: a personal-default row with a colored star/check when active, plus credential identity and reconnect/revoke actions. Agent usage and the redundant back button are removed. The preview includes the existing BreadcrumbBar for navigation. Revocation details remain in the confirmation dialog.

## Reading the story frames

Every AI review story has a **Storybook only · Review guide** above the preview. It identifies the intended app location, existing app components, proposed components, and simulated wrapper/state. Dashed boundaries mark review annotations, not product UI.

Agent preview headings, harness/model values, form buttons, and provider simulation controls are labeled **Storybook only**. The picker/authentication composition has its own marked component boundary. Real Connectors pages identify the new AI-only section inside the existing page; task stories mark the existing request component. These annotations live exclusively under `ui/storybook/` and do not appear in production.

## Existing components investigated and reused

The current `/:company/apps` route renders **Browse**, not the older Connections page. Its actual provider groups, account rows, search, Add account buttons, status icons, owner identities, and management menus are mounted in the stories. A small optional account-detail slot adds AI sign-in method, personal/shared identity, default, and delegation metadata to its existing rows.

| Existing component | Reuse in this milestone |
| --- | --- |
| `pages/apps/Browse.tsx` | Real Connectors list; existing provider groups and account rows. No standalone AI list. |
| `pages/apps/AppDetail.tsx` | Existing header, naming, identities, permission loading and account status. |
| `app-detail/IdentitiesSection.tsx` | Existing personal/company ownership display, member audience selection, and revoke confirmation dialog. |
| `app-detail/PermissionsPanel.tsx` | Existing agent access radio cards and agent selector. Only the irrelevant tool-action section is replaced with AI account/default controls. |
| `app-detail/AdvancedPanel.tsx` | Existing reconnect banner with an optional provider-auth callback, behind its existing permission check. |
| `features/connections/ConnectionSetupFlow.tsx` | Existing branded setup shell, human/agent access step, navigation, cancellation and reuse flow. Provider login is composed in a credential-content slot. |
| `features/connections/ConnectionIntentInteractionBody.tsx` | Real task card, modal, existing-account choice, completion and return-focus lifecycle. |
| `ConnectionChoiceList` | Extracted from the existing setup flow's account-reuse rows. Both that flow and the AI agent picker render this component. |
| `pages/apps/AppLogo.tsx` | Existing branding component in AI identity summaries; handles local and dark assets. |
| `AdapterLoginChrome`, `AgentConfigForm`, `AgentProviderConnection` | Existing subscription card/code/input presentation extracted into shared wrappers; live lifecycle hooks remain owned by the existing hosts. |
| `OnboardingWizard`, `ModelSourceTiles`, `CredentialModeLink` | Existing onboarding provider/method controls and API credential card remain shared. |

The separate `AiProviderPicker`, `AiConnectionRow`, and standalone AI management form have been removed. New AI-specific presentation is limited to agent binding selection, personal defaults/delegation, AI account controls, and controlled auth states. The design guide explains these boundaries and shows the shared picker and credential presentation.

## Fixture boundaries

`AiConnectorPages` mounts real route components against an isolated in-memory API. `AiTaskConnectionReview` mounts the real connection-request host. They use the production provider catalog, including the existing `anthropic` entry, and the `ai` / `runtime_auth` discriminator. Accounts and provider responses remain fixtures.

`AiConnectionsReview` covers proposed agent binding/default behavior with deterministic configuration data. Its agent/onboarding hosts are composition previews, not production route integration. The new-agent and onboarding login presentation uses the extracted existing authentication components.

No fixture contains credential material. Input values are cleared after submission; provider completion is simulated. No story signs in to a provider or grants real access. Personal-default resolution and delegation checks in `model.ts` are presentation validation, not server authorization.

## Review and verification

Review the Connectors list first, then open an account, add one, reconnect, reuse it in a task, and exercise the AI binding picker. Theme and viewport controls cover desktop/narrow and light/dark. Keyboard coverage includes the shared chooser buttons, dialogs, and return focus after cancellation/completion. Harness/model values are asserted unchanged by connection selection.

```sh
pnpm --filter @paperclipai/ui typecheck
pnpm check:token-gates
pnpm --filter @paperclipai/ui exec vitest run src/pages/apps/Browse.test.tsx src/pages/apps/AppDetail.test.tsx src/pages/apps/AppsConnect.test.tsx src/features/connections/ConnectionIntentInteractionBody.test.tsx src/components/ai-connections src/components/AdapterLoginChrome.test.tsx src/components/OnboardingWizard.adapters.test.tsx src/components/OnboardingWizard.test.tsx
pnpm build-storybook
pnpm exec playwright test --config tests/ai-connections-review/playwright.config.ts
```

Verified: 277 focused Vitest checks, 53 browser checks across 48 stories, UI typecheck, token gates, and Storybook build. Desktop and narrow screenshots were inspected in light/dark themes.

Browser checks load every AI review story, await its interaction assertions, reject rendering/play errors, verify review-index links, test keyboard selection, and capture light/dark layouts at desktop and narrow widths while checking overflow. Screenshots remain ignored local test artifacts.

The counts above record the original UI review. Integration verification is recorded in the implementation handoff; live provider verification requires valid accounts and a supported sign-in environment.

## Agreed implementation after review

- Extend existing applications/connections/grants/installations/delegations with an AI purpose and runtime-auth transport. Reuse encrypted secret storage and company access checks; keep tool/channel execution separate.
- Add typed agent bindings and personal defaults keyed by company, user, provider, and sign-in method. First successful personal connection becomes default only when none exists. Additional defaults require explicit selection; revocation never chooses a replacement.
- Resolve personal defaults from the run's responsible user. Shared and dedicated personal bindings are explicit. Only the owner can authorize their personal account across responsible users.
- Resolve the chosen grant before local, sandbox, native-runner, and test execution. Prevent inherited credentials or cached homes from overriding it; partition session/auth reuse by grant identity, preserve refresh ownership, and report actionable missing-access blockers.
- Keep provider, method, harness, and model routing fixed during connection selection. Start with Claude, OpenAI/ChatGPT, OpenRouter, and Grok/xAI, using only supported existing authentication methods and harness integrations.
- Preserve legacy execution until adoption. Index only credentials with reliable ownership; never infer ownership from account-home paths. Test and explicitly save the replacement binding; do not restore legacy fallback after adoption.
- Schema/API, runtime integration, adoption, and production UI wiring are implemented after approval. There is no separate AI Connections feature flag.
