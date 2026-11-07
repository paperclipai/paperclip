# Registry Integration Patches

Exact code to add to Paperclip's three registry files.
Apply these after copying the adapter to `packages/adapters/openrouter/`.

---

## 1. Server Registry

**File:** `server/src/adapters/registry.ts`

Add this import at the top:

```typescript
import { execute as openrouterExecute } from "@paperclipai/adapter-openrouter/server";
import { test as openrouterTest } from "@paperclipai/adapter-openrouter/server";
import { type as openrouterType, label as openrouterLabel, models as openrouterModels } from "@paperclipai/adapter-openrouter";
```

Add this entry to the `adapters` record:

```typescript
  [openrouterType]: {
    type: openrouterType,
    label: openrouterLabel,
    models: openrouterModels,
    execute: openrouterExecute,
    test: openrouterTest,
  },
```

---

## 2. UI Registry

**File:** `ui/src/adapters/registry.ts`

Add this import at the top:

```typescript
import { parseStdout as openrouterParseStdout, buildConfig as openrouterBuildConfig, configFields as openrouterConfigFields } from "@paperclipai/adapter-openrouter/ui";
import { type as openrouterType, label as openrouterLabel, models as openrouterModels } from "@paperclipai/adapter-openrouter";
```

Add this entry to the `adapters` record:

```typescript
  [openrouterType]: {
    type: openrouterType,
    label: openrouterLabel,
    models: openrouterModels,
    parseStdout: openrouterParseStdout,
    buildConfig: openrouterBuildConfig,
    configFields: openrouterConfigFields,
  },
```

---

## 3. CLI Registry

**File:** `cli/src/adapters/registry.ts`

Add this import at the top:

```typescript
import { formatEvent as openrouterFormatEvent } from "@paperclipai/adapter-openrouter/cli";
import { type as openrouterType, label as openrouterLabel } from "@paperclipai/adapter-openrouter";
```

Add this entry to the `adapters` record:

```typescript
  [openrouterType]: {
    type: openrouterType,
    label: openrouterLabel,
    formatEvent: openrouterFormatEvent,
  },
```

---

## 4. Workspace Dependencies

**File:** `server/package.json` — add to `dependencies`:

```json
"@paperclipai/adapter-openrouter": "workspace:*"
```

**File:** `cli/package.json` — add to `dependencies`:

```json
"@paperclipai/adapter-openrouter": "workspace:*"
```

**File:** `ui/package.json` — add to `dependencies`:

```json
"@paperclipai/adapter-openrouter": "workspace:*"
```

---

## 5. Rebuild

```bash
pnpm install
pnpm build
pnpm dev  # or pnpm dev:server
```

The "OpenRouter" option will now appear in the adapter type dropdown
during agent creation and in the onboarding wizard.
