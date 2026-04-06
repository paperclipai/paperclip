# CopilotKit v1 → v2 Migration

## Overview

Migrated the CopilotKit integration from v1 to v2 (AG-UI protocol). v2 APIs are accessed via subpath imports (`@copilotkit/react-core/v2`, `@copilotkit/runtime/v2`).

## Key API Changes

### Server Runtime
| v1 | v2 |
|----|-----|
| `OpenAIAdapter` | `BuiltInAgent({ model: "openai/gpt-5.4" })` |
| `copilotRuntimeNodeHttpEndpoint()` | `createCopilotEndpointSingleRouteExpress()` |
| `CopilotRuntime()` | `CopilotRuntime({ agents: { default: ... } })` |

### Package Versions
- `@copilotkit/runtime`: `^1.54.0` → `1.55.0-next.9` (v2 subpath available at `/v2`)
- `@copilotkit/react-core`: `^1.54.0` → `1.55.0-next.9` (v2 subpath available at `/v2`)
- `@copilotkit/react-ui`: removed (consolidated into `@copilotkit/react-core/v2`)
- `zod`: added to UI package (required for v2 parameter schemas)

### UI Provider
| v1 | v2 |
|----|-----|
| `CopilotKit` from `@copilotkit/react-core` | `CopilotKitProvider` from `@copilotkit/react-core/v2` |
| `@copilotkit/react-ui/styles.css` | `@copilotkit/react-core/v2/styles.css` |

### Hooks
| v1 | v2 |
|----|-----|
| `useCopilotAction` | `useFrontendTool` (Zod params) |
| `useCopilotReadable` | `useAgentContext` (same shape) |
| `useCopilotChatSuggestions` | `useConfigureSuggestions` |
| `renderAndWaitForResponse` | `useHumanInTheLoop` + `ToolCallStatus` |

### Components
| v1 | v2 |
|----|-----|
| `CopilotSidebar` from `@copilotkit/react-ui` | `CopilotSidebar` from `@copilotkit/react-core/v2` |

### CopilotSidebar Label Changes
| v1 prop | v2 prop |
|---------|---------|
| `labels.title` | `labels.modalHeaderTitle` |
| `labels.initial` | `labels.welcomeMessageText` |
| `labels.placeholder` | `labels.chatInputPlaceholder` |

### Removed Props
- `CopilotSidebar.clickOutsideToClose` — removed in v2 (only on `CopilotPopup`)

## Parameter Schema Migration

v1 used plain arrays: `[{ name, type, description, required }]`
v2 uses Zod schemas: `z.object({ field: z.string().optional().describe("...") })`

## Model String Format

v2 `BuiltInAgent` uses `provider/model` format (e.g. `openai/gpt-5.4`), not bare model names.

## Files Changed

1. `server/package.json` — added `zod` dep (already present via workspace)
2. `ui/package.json` — swapped `@copilotkit/react-ui` for direct v2 imports, added `zod`
3. `server/src/routes/copilotkit.ts` — full runtime rewrite
4. `ui/src/main.tsx` — provider + styles import
5. `ui/src/components/Layout.tsx` — CopilotSidebar import
6. `ui/src/hooks/useCopilotActions.tsx` — all 35+ hooks migrated

## References

- [v2 Express example](https://github.com/CopilotKit/CopilotKit/tree/main/examples/v2/node-express)
- [useFrontendTool docs](https://docs.copilotkit.ai/reference/hooks/useFrontendTool)
- [useHumanInTheLoop docs](https://github.com/CopilotKit/CopilotKit/blob/main/docs/content/docs/reference/v2/hooks/useHumanInTheLoop.mdx)
- [Migration guide](https://docs.copilotkit.ai/troubleshooting/migrate-to-v2)
