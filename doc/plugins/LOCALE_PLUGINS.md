# Language Pack Plugins

Status: implemented (locale-only plugin support shipped)

Language pack plugins extend Paperclip with additional display languages.
Only English is bundled in Core. All other languages are delivered through locale-only plugins.

This document covers authoring, building, installing, testing, updating, and operating language pack plugins.

## Architecture

```
Browser                                   Server
───────                                   ──────
LanguageSelector                          GET /api/languages
  → fetch /api/languages                    → scans ready plugins with manifest.locales
  → shows EN (core) + plugin languages      → returns [{ code, source, pluginKey }]

loadLanguage("ko")                        GET /api/locales/:language
  → fetch /api/locales/ko                   → reads plugin {entrypoints.ui}/locales/:lang/*.json
  → i18n.addResourceBundle()                → returns { core: {ns: translations}, custom: {} }
```

- English is the only language inlined in the UI bundle (zero latency).
- Non-English languages are fetched on demand when the user switches language.
- Language selector shows only installed/ready plugin languages (dynamic).
- Plugins with `locales` declared and no `capabilities`/`worker` are treated as locale-only.

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
    ui: "./dist/ui",       // locale files served from this directory
  },
  locales: [{
    languageCode: "es",    // BCP 47 format: /^[a-z]{2,3}(-[A-Z]{2,3})?$/
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

All translation files use **flat key structure** (Core uses `keySeparator: false`):

```json
{
  "dashboard": "Panel de Control",
  "button.save": "Guardar",
  "button.cancel": "Cancelar",
  "status.running": "Ejecutando"
}
```

Do NOT use nested objects:
```json
{
  "button": { "save": "Guardar" }
}
```

### Build

```bash
pnpm build
```

The build script must:
1. Compile TypeScript to `dist/`
2. Copy `locales/core/*.json` to `{entrypoints.ui}/locales/{lang}/`

The server resolves locale files at runtime as:
`{packagePath}/{manifest.entrypoints.ui}/locales/{lang}/{namespace}.json`

Example `package.json` scripts:
```json
{
  "scripts": {
    "build": "tsc && mkdir -p dist/ui/locales/{lang} && cp locales/core/*.json dist/ui/locales/{lang}/"
  }
}
```

## Installation

### Local path (development/testing)

```javascript
// Browser DevTools (instance-admin required)
fetch('/api/plugins/install', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    packageName: '/absolute/path/to/plugin-lang-es',
    isLocalPath: true,
  }),
}).then(r => r.json())
```

### npm (production)

```javascript
fetch('/api/plugins/install', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    packageName: '@paperclipai/plugin-lang-es',
    version: 'latest',
  }),
}).then(r => r.json())
```

> **Note:** npm install requires the package to be published (not `"private": true`).
> The install API requires instance-admin privileges.

After installation, the language appears automatically in Settings > General > Language.

## Testing

### Automated validation

```bash
./scripts/test-locale-plugin.sh
```

Checks: build output, JSON syntax, EN/KO key parity, dist file integrity.

### Manual end-to-end test

1. Build the plugin: `pnpm --filter @paperclipai/plugin-lang-ko build`
2. Start local server: `pnpm dev:once`
3. Install via API (see Installation above)
4. Verify:
   - `GET /api/languages` includes the new language with `source: "plugin"`
   - `GET /api/locales/{lang}` returns 15 namespaces with translations
   - Settings > General > Language shows the new language
   - Selecting it switches all UI text

### Docker testing

The Docker image copies the full repo into `/app`. To test inside a container:

```bash
# Build plugin inside container
docker exec <container> sh -c "
  cd /app/packages/plugins/plugin-lang-ko &&
  mkdir -p dist/ui/locales/ko &&
  cp locales/core/*.json dist/ui/locales/ko/
"

# Register via database (if no auth session available)
docker exec <db-container> psql -U paperclip -d paperclip -c "
  INSERT INTO plugins (plugin_key, package_name, package_path, version, api_version, categories, manifest_json, status, install_order)
  VALUES ('paperclip.lang-ko', '@paperclipai/plugin-lang-ko', '/app/packages/plugins/plugin-lang-ko', '0.1.0', 1, '[\"ui\"]'::jsonb, '<manifest-json>'::jsonb, 'ready', 1)
  ON CONFLICT (plugin_key) DO UPDATE SET status = 'ready', updated_at = now();
"
```

## Updating Translations

```bash
# 1. Edit locale JSON files
vim packages/plugins/plugin-lang-ko/locales/core/common.json

# 2. Run validation
./scripts/test-locale-plugin.sh

# 3. Build
pnpm --filter @paperclipai/plugin-lang-ko build

# 4. Publish (if using npm)
npm publish

# 5. Upgrade in production (instance-admin, API only — no UI button yet)
fetch('/api/plugins/<plugin-uuid>/upgrade', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ version: 'latest' }),
}).then(r => r.json())
```

The UI fetches translations with a cache-busting timestamp (`?_t=...`), so updates are reflected on next language load without browser cache issues.

## Translation Quality Guidelines

| Rule | Description |
|------|-------------|
| EN keys = source of truth | English `defaultValue` is the canonical text |
| Match all keys | Every EN key must have a corresponding translation |
| Keep technical terms | Agent, Heartbeat, Plugin, Adapter stay in English |
| Natural language | No literal translations — use contextually natural phrasing |
| Consistent honorifics | Use consistent formality level throughout |
| Consider length | Translations may be longer — check for UI overflow |
| No plural forms needed | Languages like Korean/Japanese do not distinguish plurals |

## Plugin i18n for Custom Plugins

Plugins with their own UI can provide translations for their own namespaces:

```typescript
import { usePluginTranslation } from "@paperclipai/plugin-sdk/ui";

function MyWidget() {
  const { t, language } = usePluginTranslation("plugin.myPlugin.messages");
  return <h2>{t("title", "My Widget")}</h2>;
}
```

Place locale files under `dist/ui/locales/{lang}/messages.json`.
These are loaded via `/_plugins/{pluginId}/ui/locales/{lang}/{namespace}.json`.

## Rollback

### Plugin fails to load

```javascript
// Disable the plugin (instance-admin)
fetch('/api/plugins/<id>/disable', { method: 'POST', credentials: 'include' })
// UI falls back to English (fallbackLng: "en")
// Page refresh clears stale translations from memory
```

### Language switch shows raw keys

1. Check `GET /api/locales/{lang}` — response should have `core: { namespace: { ... } }`
2. If empty: verify plugin status is "ready" via `GET /api/plugins`
3. If plugin is "installed" but not "ready": check server logs for activation errors
4. Verify plugin `dist/ui/locales/{lang}/` directory contains all 15 JSON files

## API Reference

### `GET /api/languages`

Returns available languages. English is always included as core.

```json
[
  { "code": "en", "source": "core", "pluginKey": "", "namespaces": [] },
  { "code": "ko", "source": "plugin", "pluginKey": "paperclip.lang-ko", "namespaces": ["common", "..."] }
]
```

### `GET /api/locales/:language`

Returns consolidated locale bundle for a language from all ready plugins.

```json
{
  "language": "ko",
  "version": "2026-04-20T...",
  "core": { "common": { "key": "value", "..." }, "agents": { "..." } },
  "custom": {}
}
```

- `core`: translations for Core namespaces (from locale-only plugins)
- `custom`: translations for plugin-specific namespaces (from standard plugins)

### `usePluginTranslation(namespace?)`

React hook for plugin UI components. Returns `{ t, language, ready }`.

## Current Limitations

- Plugin Manager UI only supports npm package name input. Local path install requires API call.
- Upgrade button does not exist in Plugin Manager UI. Use the API directly.
- npm publish requires removing `"private": true` from package.json.
- `removePluginLocales()` is not automatically wired to plugin disable/uninstall events. A page refresh is needed to clear stale translations.

## File Reference

| File | Purpose |
|------|---------|
| `ui/src/i18n/index.ts` | i18n init, loadLanguage() |
| `ui/src/components/LanguageSelector.tsx` | Dynamic language picker |
| `server/src/routes/plugins.ts` | Locale API endpoints |
| `server/src/services/plugin-loader.ts` | Plugin install + locale-only detection |
| `server/src/routes/plugin-ui-static.ts` | Static file serving for plugin assets |
| `packages/plugins/plugin-lang-ko/` | Korean language pack (reference implementation) |
| `packages/plugins/sdk/src/ui/hooks.ts` | usePluginTranslation() hook |
