# Language Pack Plugins

Language pack plugins extend Paperclip with support for additional languages.

## Creating a Language Pack Plugin

### Directory Structure

```
plugin-lang-{code}/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts       # re-exports manifest
│   └── manifest.ts    # plugin manifest with locales field
└── locales/
    └── core/
        ├── common.json
        ├── agents.json
        ├── costs.json
        ├── inbox.json
        ├── dashboard.json
        ├── issues.json
        ├── projects.json
        ├── goals.json
        ├── approvals.json
        ├── routines.json
        ├── settings.json
        ├── onboarding.json
        ├── skills.json
        ├── workspaces.json
        └── plugins.json
```

### Manifest

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.lang-es",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Spanish Language Pack",
  description: "Spanish (Español) translations for Paperclip.",
  author: "Community",
  categories: ["ui"],
  capabilities: [],        // locale-only — no capabilities needed
  entrypoints: {
    ui: "./dist/ui",       // locale files served from UI directory
  },
  locales: [{
    languageCode: "es",
    namespaces: [
      "common", "agents", "costs", "inbox", "dashboard",
      "issues", "projects", "goals", "approvals", "routines",
      "settings", "onboarding", "skills", "workspaces", "plugins",
    ],
  }],
};

export default manifest;
```

### JSON Format

All translation files use **flat key structure** (matching Core's `keySeparator: false`):

```json
{
  "dashboard": "Panel de Control",
  "button.save": "Guardar",
  "button.cancel": "Cancelar",
  "status.running": "Ejecutando"
}
```

**Do NOT use nested objects:**
```json
// WRONG:
{
  "button": {
    "save": "Guardar"
  }
}
```

### Build

```bash
# Build manifest + copy locale files to dist/ui/locales/{lang}/
pnpm build
```

The build script should:
1. Compile TypeScript to `dist/`
2. Copy `locales/core/*.json` to `dist/ui/locales/{lang}/`

### Installation

```bash
# From local path (recommended for language packs)
POST /api/plugins/install
{ "packageName": "@scope/plugin-lang-es", "localPath": "/path/to/plugin-lang-es" }
```

> **Note:** npm-based installation for locale-only plugins requires additional
> infrastructure (planned for a future release). Currently, language pack plugins
> must be installed from a local filesystem path.

After installation, the language appears automatically in Settings > General > Language.

## Translation Quality Guidelines

| Rule | Description |
|------|-------------|
| EN keys = source of truth | English `defaultValue` is the canonical text |
| Match all keys | Every EN key must have a corresponding translation |
| Keep technical terms | Agent, Heartbeat, Plugin, Adapter stay in English |
| Natural language | No literal translations — use contextually natural phrasing |
| Consistent honorifics | Use consistent formality level throughout |
| Consider length | Translations may be longer — check for UI overflow |
| No plural forms needed | Languages like Korean/Japanese don't distinguish plurals |

## Plugin i18n for Custom Plugins

Plugins with their own UI can also use translations:

```typescript
import { usePluginTranslation } from "@paperclipai/plugin-sdk/ui";

function MyWidget() {
  const { t, language } = usePluginTranslation("plugin.myPlugin.messages");
  return <h2>{t("title", "My Widget")}</h2>;
}
```

Place locale files under `dist/ui/locales/{lang}/messages.json`.

## API Reference

### `GET /api/plugins/languages`
Returns available languages from Core and plugins.

### `GET /api/plugins/locales/:language`
Returns consolidated locale bundle for a language from all ready plugins.

### `usePluginTranslation(namespace?)`
React hook for plugin UI components. Returns `{ t, language, ready }`.
