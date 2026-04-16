# Issue Links Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Paperclip plugin that adds a local filesystem path and a GitHub PR URL field to every issue, displayed inline in the issue detail view and settable by agents.

**Architecture:** Plugin lives at `packages/plugins/issue-links/`, mirroring the file-browser example structure. Data is stored as two plugin state keys scoped to each issue (`localPath`, `githubPrUrl`). The UI uses a `taskDetailView` slot to inject two inline property rows into the issue detail. Agents can set both fields via registered tools.

**Tech Stack:** TypeScript, React 19, Tailwind CSS (CSS variables for theming), esbuild for UI bundle, `@paperclipai/plugin-sdk`, `@paperclipai/shared`.

---

## File Map

**Create:**
- `packages/plugins/issue-links/package.json` — package definition, build scripts, deps
- `packages/plugins/issue-links/tsconfig.json` — TypeScript config extending root
- `packages/plugins/issue-links/scripts/build-ui.mjs` — esbuild UI bundle script
- `packages/plugins/issue-links/src/constants.ts` — plugin ID, slot IDs, export names, tool names, state keys
- `packages/plugins/issue-links/src/manifest.ts` — plugin manifest (capabilities, config schema, tools, UI slot)
- `packages/plugins/issue-links/src/index.ts` — worker entrypoint (re-exports plugin default)
- `packages/plugins/issue-links/src/worker.ts` — data handler, action handlers, tool handlers
- `packages/plugins/issue-links/src/ui/index.tsx` — exports `IssueLinksView` component
- `packages/plugins/issue-links/src/ui/IssueLinksView.tsx` — the two inline property rows

---

## Task 1: Scaffold package structure

**Files:**
- Create: `packages/plugins/issue-links/package.json`
- Create: `packages/plugins/issue-links/tsconfig.json`
- Create: `packages/plugins/issue-links/scripts/build-ui.mjs`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@paperclipai/plugin-issue-links",
  "version": "0.1.0",
  "description": "Plugin that adds local path and GitHub PR URL fields to issues",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "prebuild": "node ../../../scripts/ensure-plugin-build-deps.mjs",
    "build": "tsc && node ./scripts/build-ui.mjs",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk build && tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "esbuild": "^0.27.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.7.3"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
```

Save to `packages/plugins/issue-links/package.json`.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

Save to `packages/plugins/issue-links/tsconfig.json`.

- [ ] **Step 3: Create build-ui.mjs**

```js
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});
```

Save to `packages/plugins/issue-links/scripts/build-ui.mjs`.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/issue-links/package.json packages/plugins/issue-links/tsconfig.json packages/plugins/issue-links/scripts/build-ui.mjs
git commit -m "feat(issue-links): scaffold plugin package"
```

---

## Task 2: Constants

**Files:**
- Create: `packages/plugins/issue-links/src/constants.ts`

- [ ] **Step 1: Create constants.ts**

```ts
export const PLUGIN_ID = "paperclip-issue-links";
export const PLUGIN_VERSION = "0.1.0";

export const SLOT_IDS = {
  issueLinksView: "issue-links-view",
} as const;

export const EXPORT_NAMES = {
  issueLinksView: "IssueLinksView",
} as const;

export const TOOL_NAMES = {
  setLocalPath: "issue-links.set-local-path",
  setGithubPrUrl: "issue-links.set-github-pr-url",
} as const;

export const STATE_KEYS = {
  localPath: "localPath",
  githubPrUrl: "githubPrUrl",
} as const;

export const DEFAULT_CONFIG = {
  openWith: "vscode" as "vscode" | "finder",
} as const;
```

Save to `packages/plugins/issue-links/src/constants.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/issue-links/src/constants.ts
git commit -m "feat(issue-links): add constants"
```

---

## Task 3: Manifest

**Files:**
- Create: `packages/plugins/issue-links/src/manifest.ts`

- [ ] **Step 1: Create manifest.ts**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Issue Links",
  description: "Adds a local filesystem path and a GitHub PR URL field to every issue, visible inline in the issue detail view.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "agent.tools.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      openWith: {
        type: "string",
        title: "Open local path with",
        enum: ["vscode", "finder"],
        default: DEFAULT_CONFIG.openWith,
        description: "Controls what happens when a local path is clicked. 'vscode' opens with VS Code, 'finder' opens with Finder.",
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.setLocalPath,
      displayName: "Set Issue Local Path",
      description: "Set the local filesystem path for an issue. Use an absolute path such as /Users/me/projects/repo. Pass an empty string to clear the field.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID of the issue to update." },
          value: { type: "string", description: "Absolute local filesystem path, or empty string to clear." },
        },
        required: ["issueId", "value"],
      },
    },
    {
      name: TOOL_NAMES.setGithubPrUrl,
      displayName: "Set Issue GitHub PR URL",
      description: "Set the GitHub PR URL for an issue. Pass a full URL such as https://github.com/org/repo/pull/123. Pass an empty string to clear the field.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID of the issue to update." },
          value: { type: "string", description: "Full GitHub PR URL, or empty string to clear." },
        },
        required: ["issueId", "value"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "taskDetailView",
        id: SLOT_IDS.issueLinksView,
        displayName: "Issue Links",
        exportName: EXPORT_NAMES.issueLinksView,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
```

Save to `packages/plugins/issue-links/src/manifest.ts`.

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/issue-links/src/manifest.ts
git commit -m "feat(issue-links): add plugin manifest"
```

---

## Task 4: Worker

**Files:**
- Create: `packages/plugins/issue-links/src/worker.ts`
- Create: `packages/plugins/issue-links/src/index.ts`

- [ ] **Step 1: Create worker.ts**

```ts
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";

type IssueLinksConfig = {
  openWith?: "vscode" | "finder";
};

type IssueLinksData = {
  localPath: string | null;
  githubPrUrl: string | null;
};

async function getConfig(ctx: PluginContext): Promise<IssueLinksConfig> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as IssueLinksConfig) };
}

async function readIssueLinks(ctx: PluginContext, issueId: string): Promise<IssueLinksData> {
  const [localPath, githubPrUrl] = await Promise.all([
    ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }),
    ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }),
  ]);
  return {
    localPath: typeof localPath === "string" ? localPath : null,
    githubPrUrl: typeof githubPrUrl === "string" ? githubPrUrl : null,
  };
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    // Data handler: read both link fields for an issue
    ctx.data.register("issue-links", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      if (!issueId) return { localPath: null, githubPrUrl: null };
      return await readIssueLinks(ctx, issueId);
    });

    // Data handler: expose plugin config to UI
    ctx.data.register("plugin-config", async () => {
      return await getConfig(ctx);
    });

    // Action: set local path
    ctx.actions.register("set-local-path", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const value = typeof params.value === "string" ? params.value.trim() : null;
      if (!issueId) throw new Error("issueId is required");
      const normalized = value === "" || value === null ? null : value;
      if (normalized === null) {
        await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath });
      } else {
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }, normalized);
      }
      return { ok: true, issueId, localPath: normalized };
    });

    // Action: set GitHub PR URL
    ctx.actions.register("set-github-pr-url", async (params) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const value = typeof params.value === "string" ? params.value.trim() : null;
      if (!issueId) throw new Error("issueId is required");
      const normalized = value === "" || value === null ? null : value;
      if (normalized === null) {
        await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl });
      } else {
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }, normalized);
      }
      return { ok: true, issueId, githubPrUrl: normalized };
    });

    // Agent tool: set local path
    ctx.tools.register(
      TOOL_NAMES.setLocalPath,
      {
        displayName: "Set Issue Local Path",
        description: "Set the local filesystem path for an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            value: { type: "string" },
          },
          required: ["issueId", "value"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const payload = params as { issueId?: string; value?: string };
        if (!payload.issueId) return { error: "issueId is required" };
        const issueId = payload.issueId;
        const value = typeof payload.value === "string" ? payload.value.trim() : null;
        const normalized = value === "" || value === null ? null : value;
        if (normalized === null) {
          await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath });
        } else {
          await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.localPath }, normalized);
        }
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "issue",
          entityId: issueId,
          message: normalized
            ? `Issue Links: set local path to "${normalized}"`
            : "Issue Links: cleared local path",
          metadata: { plugin: PLUGIN_ID },
        });
        return {
          content: normalized ? `Local path set to "${normalized}"` : "Local path cleared",
          data: { issueId, localPath: normalized },
        };
      },
    );

    // Agent tool: set GitHub PR URL
    ctx.tools.register(
      TOOL_NAMES.setGithubPrUrl,
      {
        displayName: "Set Issue GitHub PR URL",
        description: "Set the GitHub PR URL for an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            value: { type: "string" },
          },
          required: ["issueId", "value"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const payload = params as { issueId?: string; value?: string };
        if (!payload.issueId) return { error: "issueId is required" };
        const issueId = payload.issueId;
        const value = typeof payload.value === "string" ? payload.value.trim() : null;
        const normalized = value === "" || value === null ? null : value;
        if (normalized === null) {
          await ctx.state.delete({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl });
        } else {
          await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: STATE_KEYS.githubPrUrl }, normalized);
        }
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "issue",
          entityId: issueId,
          message: normalized
            ? `Issue Links: set GitHub PR URL to "${normalized}"`
            : "Issue Links: cleared GitHub PR URL",
          metadata: { plugin: PLUGIN_ID },
        });
        return {
          content: normalized ? `GitHub PR URL set to "${normalized}"` : "GitHub PR URL cleared",
          data: { issueId, githubPrUrl: normalized },
        };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "Issue Links plugin ready" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const typed = config as IssueLinksConfig;
    if (typed.openWith !== undefined && typed.openWith !== "vscode" && typed.openWith !== "finder") {
      errors.push("openWith must be 'vscode' or 'finder'");
    }
    return { ok: errors.length === 0, errors, warnings: [] };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

Save to `packages/plugins/issue-links/src/worker.ts`.

- [ ] **Step 2: Create index.ts**

```ts
export { default } from "./worker.js";
```

Save to `packages/plugins/issue-links/src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/issue-links/src/worker.ts packages/plugins/issue-links/src/index.ts
git commit -m "feat(issue-links): add worker with data, action, and tool handlers"
```

---

## Task 5: UI component

**Files:**
- Create: `packages/plugins/issue-links/src/ui/IssueLinksView.tsx`
- Create: `packages/plugins/issue-links/src/ui/index.tsx`

- [ ] **Step 1: Create IssueLinksView.tsx**

```tsx
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { useRef, useState } from "react";

type IssueLinksData = {
  localPath: string | null;
  githubPrUrl: string | null;
};

type PluginConfig = {
  openWith?: "vscode" | "finder";
};

/**
 * Parses a GitHub PR URL into a short display label.
 * https://github.com/org/repo/pull/123 → "org/repo#123"
 * Returns null if parsing fails (caller should fall back to raw URL).
 */
function parseGithubPrUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    // pathname: /org/repo/pull/123
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") return null;
    const [org, repo, , number] = parts;
    return `${org}/${repo}#${number}`;
  } catch {
    return null;
  }
}

function buildOpenWithHref(path: string, openWith: "vscode" | "finder"): string {
  if (openWith === "vscode") {
    return `vscode://file/${encodeURIComponent(path)}`;
  }
  return `file://${path}`;
}

type LinkRowProps = {
  label: string;
  value: string | null;
  placeholder: string;
  displayValue: (value: string) => string;
  href: (value: string) => string;
  openInNewTab: boolean;
  onSave: (value: string | null) => Promise<void>;
};

function LinkRow({ label, value, placeholder, displayValue, href, openInNewTab, onSave }: LinkRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(value ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function commitEdit() {
    if (saving) return;
    setSaving(true);
    try {
      const trimmed = draft.trim();
      await onSave(trimmed === "" ? null : trimmed);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  function cancelEdit() {
    setEditing(false);
  }

  return (
    <div className="flex items-start gap-3 py-1 min-h-[28px]">
      <span className="w-[120px] shrink-0 text-xs font-medium text-muted-foreground pt-0.5">{label}</span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            className="w-full rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground outline-none focus:border-ring"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
            }}
            disabled={saving}
          />
        ) : value ? (
          <a
            href={href(value)}
            {...(openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="text-xs text-primary hover:underline truncate block"
            title={value}
            onClick={openInNewTab ? undefined : (e) => { e.preventDefault(); window.location.href = href(value); }}
          >
            {displayValue(value)}
          </a>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={startEdit}
          >
            {placeholder}
          </button>
        )}
        {value && !editing && (
          <button
            type="button"
            className="ml-2 text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            onClick={startEdit}
            title="Edit"
          >
            ✎
          </button>
        )}
      </div>
    </div>
  );
}

export function IssueLinksView() {
  const { entityId: issueId, companyId } = useHostContext();

  const { data: links, loading: linksLoading } = usePluginData<IssueLinksData>("issue-links", {
    issueId,
    companyId,
  });

  const { data: config } = usePluginData<PluginConfig>("plugin-config", {});

  const setLocalPath = usePluginAction("set-local-path");
  const setGithubPrUrl = usePluginAction("set-github-pr-url");

  const openWith = config?.openWith ?? "vscode";

  if (!issueId) return null;

  if (linksLoading) {
    return (
      <div className="space-y-1 py-1">
        <div className="flex items-start gap-3 min-h-[28px]">
          <div className="w-[120px] h-3 rounded bg-muted animate-pulse mt-0.5" />
          <div className="flex-1 h-3 rounded bg-muted animate-pulse mt-0.5" />
        </div>
        <div className="flex items-start gap-3 min-h-[28px]">
          <div className="w-[120px] h-3 rounded bg-muted animate-pulse mt-0.5" />
          <div className="flex-1 h-3 rounded bg-muted animate-pulse mt-0.5" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <LinkRow
        label="Local Path"
        value={links?.localPath ?? null}
        placeholder="Add path…"
        displayValue={(v) => v}
        href={(v) => buildOpenWithHref(v, openWith)}
        openInNewTab={false}
        onSave={async (value) => {
          await setLocalPath({ issueId, companyId, value });
        }}
      />
      <LinkRow
        label="GitHub PR"
        value={links?.githubPrUrl ?? null}
        placeholder="Add PR…"
        displayValue={(v) => parseGithubPrUrl(v) ?? v}
        href={(v) => v}
        openInNewTab={true}
        onSave={async (value) => {
          await setGithubPrUrl({ issueId, companyId, value });
        }}
      />
    </div>
  );
}
```

Save to `packages/plugins/issue-links/src/ui/IssueLinksView.tsx`.

- [ ] **Step 2: Create ui/index.tsx**

```tsx
export { IssueLinksView } from "./IssueLinksView.js";
```

Save to `packages/plugins/issue-links/src/ui/index.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/issue-links/src/ui/IssueLinksView.tsx packages/plugins/issue-links/src/ui/index.tsx
git commit -m "feat(issue-links): add IssueLinksView UI component"
```

---

## Task 6: Build and verify

**Files:** (none created, build outputs go to dist/)

- [ ] **Step 1: Install dependencies**

Run from the repo root:

```bash
pnpm --filter @paperclipai/plugin-issue-links install
```

Expected: dependencies resolved with no errors.

- [ ] **Step 2: Build the plugin**

```bash
pnpm --filter @paperclipai/plugin-issue-links build
```

Expected output (approximate):
```
> tsc
> node ./scripts/build-ui.mjs

  dist/ui/index.js  ...kb

⚡ Done in ...ms
```

If `tsc` fails with type errors, fix them before proceeding.

- [ ] **Step 3: Verify dist outputs exist**

```bash
ls packages/plugins/issue-links/dist/
```

Expected to see: `manifest.js`, `worker.js`, `ui/` directory containing `index.js`.

- [ ] **Step 4: Typecheck only (no emit)**

```bash
pnpm --filter @paperclipai/plugin-issue-links typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit dist files if needed and finalize**

```bash
git add packages/plugins/issue-links/
git commit -m "feat(issue-links): build plugin and verify outputs"
```

---

## Task 7: Register plugin in the dev/local instance

This task registers the plugin so it appears in the Paperclip admin UI. The exact method depends on whether the repo uses a plugin registry config file or a database-driven install.

- [ ] **Step 1: Check how example plugins are registered**

```bash
grep -r "plugin-file-browser-example\|plugin-kitchen-sink-example" packages/ server/ --include="*.ts" --include="*.json" -l
```

Look at the files found to understand registration pattern.

- [ ] **Step 2: Register the plugin**

If there is a config file that lists example plugins (e.g. a `plugins.json` or similar), add an entry:

```json
{
  "id": "paperclip-issue-links",
  "path": "./packages/plugins/issue-links"
}
```

If registration is done via the admin UI or CLI, follow the same pattern used for the kitchen-sink example in the README or docs.

- [ ] **Step 3: Commit registration change**

```bash
git add <registration file>
git commit -m "feat(issue-links): register plugin in local instance"
```

---

## Task 8: Manual smoke test

These are manual verification steps — no automated tests exist for plugin UI at this level.

- [ ] **Step 1: Start the dev server**

Follow the repo's standard dev start command (check root `package.json` scripts or `README.md`).

- [ ] **Step 2: Navigate to an issue detail**

Open any issue in the Paperclip UI. Scroll down in the issue detail view — the "Local Path" and "GitHub PR" rows should appear below the existing plugin task detail views.

- [ ] **Step 3: Test Local Path field**

1. Click "Add path…" — an inline input should appear
2. Type `/Users/test/myrepo` and press Enter
3. The input closes and the path text appears as a clickable link
4. Click the link — it should open `vscode://file/...` in the browser (macOS will prompt to open VS Code or show a handler error if VS Code isn't the default)
5. Click the ✎ edit button, clear the field, press Enter — the "Add path…" placeholder should return

- [ ] **Step 4: Test GitHub PR field**

1. Click "Add PR…"
2. Type `https://github.com/anthropics/claude-code/pull/42` and press Enter
3. The display should show `anthropics/claude-code#42`
4. Click it — a new tab should open to the GitHub PR URL
5. Click ✎, clear, press Enter — "Add PR…" placeholder returns

- [ ] **Step 5: Test Escape cancels edit**

Click "Add path…", type something, press Escape — input closes, field reverts to previous value.

- [ ] **Step 6: Test openWith config**

In the plugin admin settings, change `openWith` to `finder`. Click a local path link — it should now open `file://...` instead of `vscode://file/...`.

- [ ] **Step 7: Test loading skeleton**

On a slow connection (or with network throttling in DevTools), navigating to an issue should briefly show two skeleton rows before the link data loads.
