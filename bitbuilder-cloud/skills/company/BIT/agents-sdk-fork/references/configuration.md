# Configuration

Fetch https://developers.cloudflare.com/agents/api-reference/configuration/ for complete documentation.

## Wrangler Config (`wrangler.jsonc`)

```jsonc
{
  "name": "my-agent",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "MyAgent", "class_name": "MyAgent" },
      { "name": "ChatAgent", "class_name": "ChatAgent" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MyAgent", "ChatAgent"] }
  ],
  "ai": { "binding": "AI" },
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  }
}
```

## Key Rules

- Every agent class needs a DO binding AND a `new_sqlite_classes` migration entry
- `nodejs_compat` is required
- Never edit old migrations — add a new tag (e.g. `v2`) for new classes
- Do NOT enable `experimentalDecorators` in tsconfig — it breaks `@callable`
- For Workers AI locally, set `"ai": { "binding": "AI", "remote": true }` in `.dev.vars` or config
- Use `wrangler secret put` for secrets, never hardcode them

## Vite Setup

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { agents } from "agents/vite";

export default defineConfig({
  plugins: [react(), cloudflare(), agents()]
});
```

## Type Generation

```bash
npx wrangler types
```

This generates `env.d.ts` with typed bindings. Regenerate after changing `wrangler.jsonc`.

## tsconfig

Extend the agents tsconfig for correct settings:

```jsonc
{
  "extends": ["agents/tsconfig"],
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "compilerOptions": { "paths": { "~/*": ["./src/*"] } }
}
```
