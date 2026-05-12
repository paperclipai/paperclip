# Paperclip Kubernetes Sandbox Provider Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `@paperclipai/plugin-kubernetes` sandbox-provider plugin that dispatches agent runs as Kubernetes `Job`s, replacing the deferred M-stack in-tree k8s adapter and the Daytona-bundled-Helm pivot. End state: an operator can `paperclipai plugin install @paperclipai/plugin-kubernetes`, create a `sandbox(driver: kubernetes)` environment, bind an agent to it, and have runs dispatch to per-tenant pods using only stable k8s APIs (no alpha CRDs, no extra operator install).

**Architecture:** Plugin sits behind paperclip's existing `PluginEnvironment*` interface (same shape as `daytona` and `e2b` plugins). Internally: a `KubeClient` factory resolves auth (in-cluster / inline kubeconfig / kubeconfig secret-ref); a `TenantOrchestrator` ensures a per-company namespace with ResourceQuota + LimitRange + deny-all NetworkPolicy + egress allow-list + per-tenant ServiceAccount; a `PodSpecBuilder` assembles security-hardened Job manifests (non-root, drop ALL caps, read-only rootFS, Tini PID 1, explicit emptyDir mounts for writable paths, `backoffLimit: 0`, `ttlSecondsAfterFinished`); a `JobOrchestrator` creates/watches/deletes Jobs; a `SecretManager` mints per-run ephemeral Secrets owned by the Job (cascade-delete). Network policy generation supports both standard `NetworkPolicy` (CIDR-based) and Cilium `CiliumNetworkPolicy` (FQDN-based) lifted from M3a.

**Why Job and not the `Sandbox` CRD from `kubernetes-sigs/agent-sandbox`:** the Sandbox CRD is still v1alpha1 with breaking changes landing (e.g. removal of automatic Service creation in issue #746). Its Beta milestone has no assignee, no due date, and the project roadmap places Beta/GA behind ~20 other priorities. Realistic stability timeline: 3-6 months. Of the Sandbox CRD's features (stable hostname/Service, persistent storage, warm pools, pause/resume, templates), this plugin uses essentially none — agent runs are one-shot ephemeral pods that talk OUT to paperclip-server, never receive inbound traffic, don't persist state across runs. Kubernetes `Job` (stable since k8s 1.13) provides exactly the lifecycle we need: one-shot, no retry, owned Pod, auto-GC via TTL, cascade-delete. We can revisit agent-sandbox post-v1beta1 if their warm-pool / template primitives become valuable to us.

**Tech Stack:**
- TypeScript 5.7+, Node 22+, ESM
- `@paperclipai/plugin-sdk` (existing) — plugin scaffolding + worker bootstrap
- `@kubernetes/client-node` ^1.0.0 — k8s API client
- `zod` ^3.24 — config validation (existing pattern)
- `vitest` ^3 — unit + integration tests (existing pattern)
- Standard k8s APIs only: `batch/v1` Job, `v1` Pod/Secret/Namespace/ServiceAccount/ResourceQuota/LimitRange, `rbac/v1` Role/RoleBinding, `networking/v1` NetworkPolicy, `cilium.io/v2` CiliumNetworkPolicy (optional)

---

## File Structure

```
packages/plugins/sandbox-providers/kubernetes/
├── package.json                          # npm package metadata
├── tsconfig.json                         # TS compile config
├── vitest.config.ts                      # Test runner config
├── README.md                             # Operator install + config docs
├── src/
│   ├── index.ts                          # entrypoint: export { manifest, plugin }
│   ├── worker.ts                         # plugin worker bootstrap (mirrors daytona)
│   ├── manifest.ts                       # PaperclipPluginManifestV1
│   ├── plugin.ts                         # definePlugin(...) — wires PluginEnvironment* hooks
│   ├── types.ts                          # KubernetesProviderConfig + Zod schema + lease metadata
│   ├── kube-client.ts                    # KubeClient factory + auth resolution
│   ├── adapter-defaults.ts               # registry: claude_local → { image, envKeys, allowFqdns, probeCommand }
│   ├── image-allowlist.ts                # globMatch + validateImage
│   ├── pod-spec-builder.ts               # buildJobManifest (security baseline + volumes + env)
│   ├── network-policy.ts                 # buildNetworkPolicyManifests (deny-all + egress allow)
│   ├── cilium-network-policy.ts          # buildCiliumNetworkPolicyManifests (FQDN allow-list)
│   ├── tenant-orchestrator.ts            # ensureTenant: ns + sa + role + rb + quota + lr + np
│   ├── secret-manager.ts                 # createPerRunSecret with ownerReferences
│   ├── sandbox-orchestrator.ts       # SandboxOrchestrator interface (swap point for runtime backends)
│   ├── job-orchestrator.ts           # Job-backed SandboxOrchestrator: create / poll / find pod / stream logs / delete batch/v1 Jobs
│   ├── workspace.ts                      # workspace ConfigMap + workspace-init init container
│   └── utils.ts                          # company-slug derivation, ULID helpers, label helpers
├── test/
│   ├── unit/
│   │   ├── types.test.ts
│   │   ├── adapter-defaults.test.ts
│   │   ├── image-allowlist.test.ts
│   │   ├── pod-spec-builder.test.ts
│   │   ├── network-policy.test.ts
│   │   ├── cilium-network-policy.test.ts
│   │   ├── tenant-orchestrator.test.ts
│   │   ├── secret-manager.test.ts
│   │   ├── job-orchestrator.test.ts
│   │   └── plugin.test.ts                # PluginEnvironment* lifecycle wiring
│   └── integration/
│       ├── _kind-harness.ts              # boot/verify kind context, namespace cleanup helpers
│       ├── tenant-provisioning.test.ts   # ensureTenant idempotency on real cluster
│       ├── end-to-end-run.test.ts        # acquireLease → execute → releaseLease against alpine:3.20
│       └── quota-enforcement.test.ts     # over-quota run gets rejected
└── manifests/
    └── operator-prerequisites.yaml       # reference: documents that no CRD install is required (k8s 1.27+ stable APIs only)
```

Total estimated production LOC: ~900. Total estimated test LOC: ~1500.

**File responsibilities:**

| File | Lines (est) | Responsibility |
|---|---|---|
| `types.ts` | 80 | KubernetesProviderConfig Zod schema + TS types + lease metadata shape |
| `kube-client.ts` | 120 | Auth resolution (in-cluster → kubeconfig string → secret-ref), client cache |
| `adapter-defaults.ts` | 60 | Registry of adapter_type → image/envKeys/allowFqdns/probeCommand |
| `image-allowlist.ts` | 40 | glob match (`*` and `?` wildcards), validateImage throws/passes |
| `pod-spec-builder.ts` | 180 | buildJobManifest: security baseline + volumes + env + Tini wrapping |
| `network-policy.ts` | 120 | NetworkPolicy YAML for deny-all + egress allow-list (CIDR-based) |
| `cilium-network-policy.ts` | 110 | CiliumNetworkPolicy YAML for FQDN-based egress (lifted from M3a) |
| `tenant-orchestrator.ts` | 150 | ensureTenant: idempotent creation of ns + sa + role + rb + quota + lr + np |
| `secret-manager.ts` | 80 | createPerRunSecret with ownerReferences to the owning Job |
| `sandbox-orchestrator.ts` | 60 | SandboxOrchestrator interface — swap point for runtime backends (Job today, Kata-FC warm pool / agent-sandbox CRD future) |
| `job-orchestrator.ts` | 200 | Job-backed conformance to SandboxOrchestrator: createJob / getJobStatus / findPodForJob / streamPodLogs / deleteJob / waitForJobCompletion via batch/v1 |
| `workspace.ts` | 80 | ConfigMap with workspace files; workspace-init init container spec |
| `plugin.ts` | 180 | definePlugin wiring (acquireLease/execute/releaseLease/probe) |
| `manifest.ts` | 100 | PaperclipPluginManifestV1 with environmentDrivers config schema |
| `worker.ts` | 5 | runWorker(plugin) — bootstrap |
| `index.ts` | 5 | re-exports |
| `utils.ts` | 60 | slugify, label helpers, ULID, error-mapping |

---

## Phase 0 — Scaffolding (1 task)

### Task 1: Initialize the plugin package

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/package.json`
- Create: `packages/plugins/sandbox-providers/kubernetes/tsconfig.json`
- Create: `packages/plugins/sandbox-providers/kubernetes/vitest.config.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/src/index.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/src/worker.ts`

- [ ] **Step 1: Create `package.json`** (mirrors daytona's, with k8s deps and our package name)

```json
{
  "name": "@paperclipai/plugin-kubernetes",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "manifests", "README.md"],
  "scripts": {
    "postinstall": "node ../../../../scripts/link-plugin-dev-sdk.mjs",
    "prebuild": "pnpm -C ../../../.. --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "rm -rf dist && tsc",
    "clean": "rm -rf dist",
    "typecheck": "pnpm -C ../../../.. --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "prepack": "rm -f package.dev.json && cp package.json package.dev.json && node ../../../../scripts/generate-plugin-package-json.mjs",
    "postpack": "if [ -f package.dev.json ]; then mv package.dev.json package.json; fi"
  },
  "dependencies": {
    "@kubernetes/client-node": "^1.0.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      ...(process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? ["test/integration/**/*.test.ts"] : []),
    ],
    testTimeout: process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? 120_000 : 5_000,
  },
});
```

- [ ] **Step 4: Create `src/index.ts`**

```ts
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./plugin.js";
```

- [ ] **Step 5: Create `src/worker.ts`**

```ts
import { runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 6: Install dependencies and verify package resolves**

Run: `cd packages/plugins/sandbox-providers/kubernetes && pnpm install --ignore-workspace`
Expected: `+ @kubernetes/client-node 1.x.x` in installed deps; no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/package.json \
        packages/plugins/sandbox-providers/kubernetes/tsconfig.json \
        packages/plugins/sandbox-providers/kubernetes/vitest.config.ts \
        packages/plugins/sandbox-providers/kubernetes/src/index.ts \
        packages/plugins/sandbox-providers/kubernetes/src/worker.ts
git commit -m "feat(plugin-kubernetes): scaffold package skeleton"
```

---

## Phase 1 — Foundation types and config schema (1 task)

### Task 2: Config schema and lease metadata types

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/types.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/types.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster`, `kubeconfig`, or `kubeconfigSecretRef`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd packages/plugins/sandbox-providers/kubernetes && pnpm test`
Expected: FAIL — "Cannot find module '../../src/types.js'"

- [ ] **Step 3: Implement `src/types.ts`**

```ts
import { z } from "zod";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),
    kubeconfigSecretRef: z.string().uuid().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig || cfg.kubeconfigSecretRef,
    {
      message:
        "kubernetes provider requires one of `inCluster`, `kubeconfig`, or `kubeconfigSecretRef`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `pnpm test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/types.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/types.test.ts
git commit -m "feat(plugin-kubernetes): config schema and lease metadata types"
```

---

## Phase 2 — Adapter defaults registry (1 task)

### Task 3: Adapter defaults registry

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/adapter-defaults.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/adapter-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/adapter-defaults.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getAdapterDefaults, KNOWN_ADAPTER_TYPES } from "../../src/adapter-defaults.js";

describe("adapter-defaults", () => {
  it("returns defaults for claude_local", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/agent-runtime-claude:v1");
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
    expect(d.probeCommand).toEqual(["claude", "--version"]);
  });

  it("returns defaults for codex_local", () => {
    const d = getAdapterDefaults("codex_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/agent-runtime-codex:v1");
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.probeCommand).toEqual(["codex", "--version"]);
  });

  it("throws on unknown adapter type", () => {
    expect(() => getAdapterDefaults("nonexistent_local")).toThrow(/unknown adapter type/i);
  });

  it("KNOWN_ADAPTER_TYPES contains all 7 supported adapters", () => {
    expect(KNOWN_ADAPTER_TYPES).toEqual(
      new Set([
        "claude_local",
        "codex_local",
        "gemini_local",
        "cursor_local",
        "opencode_local",
        "acpx_local",
        "pi_local",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/adapter-defaults.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/adapter-defaults.ts`**

```ts
export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
}

const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  cursor_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-cursor:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["cursor-agent", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  acpx_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-acpx:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["acpx", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

export const KNOWN_ADAPTER_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

export function getAdapterDefaults(adapterType: string): AdapterDefaults {
  const defaults = REGISTRY[adapterType];
  if (!defaults) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  return defaults;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/adapter-defaults.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/adapter-defaults.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/adapter-defaults.test.ts
git commit -m "feat(plugin-kubernetes): adapter defaults registry"
```

---

## Phase 3 — Image allowlist (1 task)

### Task 4: Image allowlist glob matching

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/image-allowlist.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/image-allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/image-allowlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { globMatch, resolveImage } from "../../src/image-allowlist.js";

describe("globMatch", () => {
  it("matches exact image", () => {
    expect(globMatch("ghcr.io/paperclipai/agent-runtime-claude:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(true);
  });

  it("matches single-character wildcard", () => {
    expect(globMatch("ghcr.io/x:v?", "ghcr.io/x:v1")).toBe(true);
    expect(globMatch("ghcr.io/x:v?", "ghcr.io/x:v12")).toBe(false);
  });

  it("matches multi-character wildcard", () => {
    expect(globMatch("ghcr.io/paperclipai/*:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(true);
    expect(globMatch("ghcr.io/paperclipai/*:v1", "docker.io/other/img:v1")).toBe(false);
  });

  it("does not allow wildcard to span slashes by default", () => {
    expect(globMatch("ghcr.io/*:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(false);
  });
});

describe("resolveImage", () => {
  const defaults = { runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1" };

  it("uses adapter default when no override", () => {
    expect(resolveImage({ imageOverride: null }, defaults, { imageAllowList: [], imageRegistry: undefined })).toBe(
      "ghcr.io/paperclipai/agent-runtime-claude:v1",
    );
  });

  it("rewrites registry when imageRegistry is set", () => {
    expect(
      resolveImage(
        { imageOverride: null },
        defaults,
        { imageAllowList: [], imageRegistry: "registry.example.com/paperclip" },
      ),
    ).toBe("registry.example.com/paperclip/agent-runtime-claude:v1");
  });

  it("accepts imageOverride when in allowlist", () => {
    expect(
      resolveImage(
        { imageOverride: "registry.example.com/mine:v2" },
        defaults,
        { imageAllowList: ["registry.example.com/*:v2"], imageRegistry: undefined },
      ),
    ).toBe("registry.example.com/mine:v2");
  });

  it("rejects imageOverride not in allowlist", () => {
    expect(() =>
      resolveImage(
        { imageOverride: "evil.io/img:latest" },
        defaults,
        { imageAllowList: ["registry.example.com/*"], imageRegistry: undefined },
      ),
    ).toThrow(/not in allowlist/);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/image-allowlist.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/image-allowlist.ts`**

```ts
/**
 * Glob matching for image references.
 * - `*` matches any sequence of characters EXCEPT `/` (so a wildcard doesn't span path segments)
 * - `?` matches exactly one character (excluding `/`)
 */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return re.test(value);
}

export interface ResolveImageInput {
  imageOverride?: string | null;
}

export interface ResolveImageDefaults {
  runtimeImage: string;
}

export interface ResolveImageConfig {
  imageAllowList: string[];
  imageRegistry?: string;
}

export function resolveImage(
  target: ResolveImageInput,
  defaults: ResolveImageDefaults,
  config: ResolveImageConfig,
): string {
  if (target.imageOverride) {
    if (!config.imageAllowList.some((p) => globMatch(p, target.imageOverride!))) {
      throw new Error(`Image override "${target.imageOverride}" is not in allowlist`);
    }
    return target.imageOverride;
  }
  if (config.imageRegistry) {
    return rewriteRegistry(defaults.runtimeImage, config.imageRegistry);
  }
  return defaults.runtimeImage;
}

function rewriteRegistry(image: string, registry: string): string {
  // image is like "ghcr.io/paperclipai/agent-runtime-claude:v1"
  // we want to replace the first two path segments (host + org) with `registry`
  const cleanRegistry = registry.replace(/\/+$/, "");
  const colonIdx = image.lastIndexOf(":");
  const tag = colonIdx >= 0 ? image.slice(colonIdx) : "";
  const path = colonIdx >= 0 ? image.slice(0, colonIdx) : image;
  const segments = path.split("/");
  // Strip the host+org (first two segments), keep the image name
  const imageName = segments.slice(2).join("/") || segments[segments.length - 1];
  return `${cleanRegistry}/${imageName}${tag}`;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/image-allowlist.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/image-allowlist.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/image-allowlist.test.ts
git commit -m "feat(plugin-kubernetes): image allowlist glob matching"
```

---

## Phase 4 — Kube client factory (1 task)

### Task 5: KubeClient factory with auth resolution

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/kube-client.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/kube-client.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/kube-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { createKubeConfig } from "../../src/kube-client.js";

describe("createKubeConfig", () => {
  it("loads from inline kubeconfig string", () => {
    const yaml = `apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster:
      server: https://fake.example.com
contexts:
  - name: test
    context:
      cluster: test
      user: test
current-context: test
users:
  - name: test
    user:
      token: fake-token
`;
    const kc = createKubeConfig({ inCluster: false, kubeconfig: yaml });
    expect(kc.getCurrentContext()).toBe("test");
    expect(kc.getCurrentCluster()?.server).toBe("https://fake.example.com");
  });

  it("loads from-cluster config when inCluster=true", () => {
    // Mocks: we can't actually load from cluster in tests; we verify the
    // function tries by checking it uses KubeConfig.loadFromCluster.
    const spy = vi.spyOn(KubeConfig.prototype, "loadFromCluster").mockImplementation(function (this: KubeConfig) {
      // mimic: add a fake cluster + context so currentContext is non-empty
      this.loadFromString(`apiVersion: v1
kind: Config
clusters: [{name: in-cluster, cluster: {server: 'https://kubernetes.default.svc'}}]
contexts: [{name: in-cluster, context: {cluster: in-cluster, user: in-cluster}}]
current-context: in-cluster
users: [{name: in-cluster, user: {token: tok}}]`);
    });
    const kc = createKubeConfig({ inCluster: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(kc.getCurrentContext()).toBe("in-cluster");
    spy.mockRestore();
  });

  it("throws when neither inCluster nor kubeconfig string is provided", () => {
    expect(() => createKubeConfig({ inCluster: false })).toThrow(/requires/i);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/kube-client.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/kube-client.ts`**

```ts
import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
} from "@kubernetes/client-node";

export interface CreateKubeConfigInput {
  inCluster?: boolean;
  kubeconfig?: string; // inline kubeconfig YAML
}

export function createKubeConfig(input: CreateKubeConfigInput): KubeConfig {
  const kc = new KubeConfig();
  if (input.inCluster) {
    kc.loadFromCluster();
    return kc;
  }
  if (input.kubeconfig && input.kubeconfig.trim().length > 0) {
    kc.loadFromString(input.kubeconfig);
    return kc;
  }
  throw new Error("createKubeConfig requires either inCluster=true or a kubeconfig string");
}

export interface KubeClients {
  core: CoreV1Api;
  apps: AppsV1Api;
  batch: BatchV1Api;
  custom: CustomObjectsApi;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  return {
    core: kc.makeApiClient(CoreV1Api),
    apps: kc.makeApiClient(AppsV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    networking: kc.makeApiClient(NetworkingV1Api),
    rbac: kc.makeApiClient(RbacAuthorizationV1Api),
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/kube-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/kube-client.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/kube-client.test.ts
git commit -m "feat(plugin-kubernetes): KubeConfig factory + client bundle"
```

---

## Phase 5 — Utilities (1 task)

### Task 6: Slug derivation, ULID, label helpers

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/utils.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/utils.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/utils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveCompanySlug, deriveNamespaceName, newRunUlidDns, paperclipLabels } from "../../src/utils.js";

describe("deriveCompanySlug", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(deriveCompanySlug("Acme Co!")).toBe("acme-co");
  });

  it("truncates to 32 chars and strips trailing dashes", () => {
    expect(deriveCompanySlug("A".repeat(50))).toBe("a".repeat(32));
    expect(deriveCompanySlug("ab---")).toBe("ab");
  });

  it("falls back to 'company' on empty/zero-letter input", () => {
    expect(deriveCompanySlug("!!!")).toBe("company");
    expect(deriveCompanySlug("")).toBe("company");
  });
});

describe("deriveNamespaceName", () => {
  it("concatenates prefix and slug", () => {
    expect(deriveNamespaceName("paperclip-", "acme-co")).toBe("paperclip-acme-co");
  });
});

describe("newRunUlidDns", () => {
  it("produces a DNS-safe 26-char lowercase id", () => {
    const id = newRunUlidDns();
    expect(id).toMatch(/^[a-z0-9]{26}$/);
  });
});

describe("paperclipLabels", () => {
  it("returns canonical label map", () => {
    const labels = paperclipLabels({ runId: "r1", agentId: "a1", companyId: "c1", adapterType: "claude_local" });
    expect(labels["paperclip.io/run-id"]).toBe("r1");
    expect(labels["paperclip.io/agent-id"]).toBe("a1");
    expect(labels["paperclip.io/company-id"]).toBe("c1");
    expect(labels["paperclip.io/adapter"]).toBe("claude_local");
    expect(labels["paperclip.io/managed-by"]).toBe("paperclip-k8s-plugin");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/utils.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/utils.ts`**

```ts
const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function deriveCompanySlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "company";
}

export function deriveNamespaceName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

export function newRunUlidDns(now: () => number = Date.now): string {
  const timestamp = now();
  let out = "";
  let t = timestamp;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t & 0x1f] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    out += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return out;
}

export interface LabelsInput {
  runId: string;
  agentId: string;
  companyId: string;
  adapterType: string;
}

export function paperclipLabels(input: LabelsInput): Record<string, string> {
  return {
    "paperclip.io/run-id": input.runId,
    "paperclip.io/agent-id": input.agentId,
    "paperclip.io/company-id": input.companyId,
    "paperclip.io/adapter": input.adapterType,
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/utils.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/utils.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/utils.test.ts
git commit -m "feat(plugin-kubernetes): slug, ULID, and label helpers"
```

---

## Phase 6 — Pod spec builder (1 task)

### Task 7: Security-hardened Job manifest builder

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/pod-spec-builder.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/pod-spec-builder.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/pod-spec-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildJobManifest } from "../../src/pod-spec-builder.js";

const baseInput = {
  namespace: "paperclip-acme",
  jobName: "r-01h00000000000000000000000",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envSecretName: "r-01h00000000000000000000000-env",
  serviceAccountName: "paperclip-tenant-sa",
  labels: { "paperclip.io/run-id": "r1" },
  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "2", memory: "4Gi" } },
  runtimeClassName: undefined,
  activeDeadlineSec: 3600,
  ttlSecondsAfterFinished: 900,
};

describe("buildJobManifest", () => {
  it("returns a Job manifest with the correct apiVersion and kind", () => {
    const job = buildJobManifest(baseInput);
    expect(job.apiVersion).toBe("batch/v1");
    expect(job.kind).toBe("Job");
  });

  it("sets Job-level lifecycle controls: backoffLimit=0, ttlSecondsAfterFinished, activeDeadlineSeconds", () => {
    const job = buildJobManifest({ ...baseInput, activeDeadlineSec: 1800, ttlSecondsAfterFinished: 600 });
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBe(600);
    expect(job.spec.activeDeadlineSeconds).toBe(1800);
  });

  it("sets the security context to non-root, drop ALL caps, read-only rootFS, seccomp RuntimeDefault", () => {
    const job = buildJobManifest(baseInput);
    const podSec = job.spec.template.spec.securityContext;
    expect(podSec.runAsNonRoot).toBe(true);
    expect(podSec.runAsUser).toBe(1000);
    expect(podSec.fsGroupChangePolicy).toBe("OnRootMismatch");
    expect(podSec.seccompProfile.type).toBe("RuntimeDefault");

    const container = job.spec.template.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("wraps the entrypoint in tini for PID 1", () => {
    const job = buildJobManifest(baseInput);
    const container = job.spec.template.spec.containers[0];
    expect(container.command).toEqual(["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"]);
  });

  it("declares explicit writable emptyDir mounts for the standard agent paths", () => {
    const job = buildJobManifest(baseInput);
    const mounts = job.spec.template.spec.containers[0].volumeMounts;
    const mountPaths = mounts.map((m: { mountPath: string }) => m.mountPath).sort();
    expect(mountPaths).toEqual(["/home/paperclip", "/home/paperclip/.cache", "/tmp", "/workspace"]);

    const volumes = job.spec.template.spec.volumes;
    expect(volumes.every((v: { emptyDir?: unknown }) => v.emptyDir !== undefined)).toBe(true);
  });

  it("envFrom references the per-run secret", () => {
    const job = buildJobManifest(baseInput);
    const envFrom = job.spec.template.spec.containers[0].envFrom;
    expect(envFrom[0].secretRef.name).toBe(baseInput.envSecretName);
  });

  it("applies runtimeClassName when set", () => {
    const job = buildJobManifest({ ...baseInput, runtimeClassName: "kata-fc" });
    expect(job.spec.template.spec.runtimeClassName).toBe("kata-fc");
  });

  it("does not set runtimeClassName when unset", () => {
    const job = buildJobManifest(baseInput);
    expect(job.spec.template.spec.runtimeClassName).toBeUndefined();
  });

  it("sets pod restartPolicy=Never (required for Job)", () => {
    const job = buildJobManifest(baseInput);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
  });

  it("applies the provided labels to both Job metadata and pod template", () => {
    const job = buildJobManifest(baseInput);
    expect(job.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(job.spec.template.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(job.spec.template.metadata.labels["paperclip.io/role"]).toBe("agent");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/pod-spec-builder.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/pod-spec-builder.ts`**

```ts
export interface BuildJobManifestInput {
  namespace: string;
  jobName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  activeDeadlineSec: number;
  ttlSecondsAfterFinished: number;
  imagePullSecrets?: string[];
}

export function buildJobManifest(input: BuildJobManifestInput): Record<string, unknown> {
  const podLabels = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: { ...input.labels },
    },
    spec: {
      backoffLimit: 0,                                  // paperclip handles retries; never retry at Job level
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSec,
      template: {
        metadata: { labels: podLabels },
        spec: {
          serviceAccountName: input.serviceAccountName,
          automountServiceAccountToken: true,
          restartPolicy: "Never",                       // required for Job
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources.limits ?? { cpu: "2", memory: "4Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
          ],
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/pod-spec-builder.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/pod-spec-builder.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/pod-spec-builder.test.ts
git commit -m "feat(plugin-kubernetes): security-hardened pod spec builder"
```

---

## Phase 7 — Standard NetworkPolicy generator (1 task)

### Task 8: NetworkPolicy manifests (deny-all + egress allow-list)

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/network-policy.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/network-policy.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/network-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildNetworkPolicyManifests } from "../../src/network-policy.js";

describe("buildNetworkPolicyManifests", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowCidrs: [] as string[],
  };

  it("produces a deny-all + egress allow pair", () => {
    const manifests = buildNetworkPolicyManifests(baseInput);
    expect(manifests).toHaveLength(2);
    expect(manifests[0].metadata.name).toBe("paperclip-deny-all");
    expect(manifests[1].metadata.name).toBe("paperclip-egress-allow");
  });

  it("deny-all has no ingress/egress rules and applies to all pods", () => {
    const [denyAll] = buildNetworkPolicyManifests(baseInput);
    expect(denyAll.spec.podSelector).toEqual({});
    expect(denyAll.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(denyAll.spec.ingress).toBeUndefined();
    expect(denyAll.spec.egress).toBeUndefined();
  });

  it("egress allow includes kube-dns and paperclip-server callback", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const rules = egress.spec.egress;
    const dnsRule = rules.find((r: { ports?: { protocol: string; port: number }[] }) =>
      r.ports?.some((p) => p.port === 53),
    );
    expect(dnsRule).toBeDefined();
    const paperclipRule = rules.find((r: { to: { namespaceSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "paperclip"),
    );
    expect(paperclipRule).toBeDefined();
  });

  it("includes user-supplied CIDRs in egress allow", () => {
    const [, egress] = buildNetworkPolicyManifests({ ...baseInput, egressAllowCidrs: ["10.0.0.0/8"] });
    const cidrRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "10.0.0.0/8"),
    );
    expect(cidrRule).toBeDefined();
  });

  it("uses paperclip-server pod label selector for callback ingress to paperclip ns", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const callbackRule = egress.spec.egress.find((r: { to: { podSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.podSelector?.matchLabels?.app === "paperclip-server"),
    );
    expect(callbackRule).toBeDefined();
    expect(callbackRule.ports[0].port).toBe(3100);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/network-policy.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/network-policy.ts`**

```ts
export interface BuildNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowCidrs: string[];
}

export function buildNetworkPolicyManifests(input: BuildNetworkPolicyInput): Record<string, unknown>[] {
  const denyAll = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "paperclip-deny-all",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
    },
  };

  const egressAllow: Record<string, unknown> = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "paperclip-egress-allow",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: { matchLabels: { "paperclip.io/role": "agent" } },
      policyTypes: ["Egress"],
      egress: [
        // DNS to kube-dns
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        // Paperclip-server callback
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.paperclipServerNamespace } },
              podSelector: { matchLabels: { app: "paperclip-server" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 3100 }],
        },
        // User-supplied CIDRs
        ...input.egressAllowCidrs.map((cidr) => ({
          to: [{ ipBlock: { cidr } }],
        })),
      ],
    },
  };

  return [denyAll, egressAllow];
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/network-policy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/network-policy.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/network-policy.test.ts
git commit -m "feat(plugin-kubernetes): standard NetworkPolicy generator (deny-all + egress allow)"
```

---

## Phase 8 — CiliumNetworkPolicy generator (1 task)

### Task 9: CiliumNetworkPolicy for FQDN-based egress (lift from M3a)

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/cilium-network-policy.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/cilium-network-policy.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/cilium-network-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildCiliumNetworkPolicyManifest } from "../../src/cilium-network-policy.js";

describe("buildCiliumNetworkPolicyManifest", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
  };

  it("returns a CiliumNetworkPolicy with the correct apiVersion and kind", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.apiVersion).toBe("cilium.io/v2");
    expect(cnp.kind).toBe("CiliumNetworkPolicy");
  });

  it("targets agent pods by role label", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.spec.endpointSelector.matchLabels["paperclip.io/role"]).toBe("agent");
  });

  it("includes an FQDN allow rule for each adapter FQDN", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
    });
    const fqdnRule = cnp.spec.egress.find((e: { toFQDNs?: { matchName: string }[] }) => e.toFQDNs);
    expect(fqdnRule).toBeDefined();
    expect(fqdnRule.toFQDNs.map((f: { matchName: string }) => f.matchName).sort()).toEqual([
      "api.anthropic.com",
      "api.openai.com",
    ]);
  });

  it("permits DNS to kube-dns explicitly so FQDN resolution can happen", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    const dnsRule = cnp.spec.egress.find((e: { toPorts?: { ports: { port: string }[] }[] }) =>
      e.toPorts?.some((tp) => tp.ports.some((p) => p.port === "53")),
    );
    expect(dnsRule).toBeDefined();
  });

  it("includes a rule for paperclip-server callback", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    const cb = cnp.spec.egress.find((e: { toEndpoints?: { matchLabels: Record<string, string> }[] }) =>
      e.toEndpoints?.some((ep) => ep.matchLabels.app === "paperclip-server"),
    );
    expect(cb).toBeDefined();
  });

  it("includes user-supplied CIDRs in toCIDRSet rule", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowCidrs: ["10.0.0.0/8"],
    });
    const cidrRule = cnp.spec.egress.find((e: { toCIDRSet?: { cidr: string }[] }) => e.toCIDRSet);
    expect(cidrRule.toCIDRSet[0].cidr).toBe("10.0.0.0/8");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/cilium-network-policy.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/cilium-network-policy.ts`**

```ts
export interface BuildCiliumNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowFqdns: string[];
  egressAllowCidrs: string[];
}

export function buildCiliumNetworkPolicyManifest(input: BuildCiliumNetworkPolicyInput): Record<string, unknown> {
  const egress: Record<string, unknown>[] = [];

  // DNS to kube-dns — required so FQDN resolution + Cilium DNS proxy work
  egress.push({
    toEndpoints: [
      { matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } },
    ],
    toPorts: [
      {
        ports: [
          { port: "53", protocol: "UDP" },
          { port: "53", protocol: "TCP" },
        ],
        rules: { dns: [{ matchPattern: "*" }] },
      },
    ],
  });

  // FQDN-based egress
  if (input.egressAllowFqdns.length > 0) {
    egress.push({
      toFQDNs: input.egressAllowFqdns.map((fqdn) => ({ matchName: fqdn })),
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  // Paperclip-server callback
  egress.push({
    toEndpoints: [
      {
        matchLabels: {
          "k8s:io.kubernetes.pod.namespace": input.paperclipServerNamespace,
          app: "paperclip-server",
        },
      },
    ],
    toPorts: [{ ports: [{ port: "3100", protocol: "TCP" }] }],
  });

  // User-supplied CIDRs
  if (input.egressAllowCidrs.length > 0) {
    egress.push({
      toCIDRSet: input.egressAllowCidrs.map((cidr) => ({ cidr })),
    });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: "paperclip-egress-fqdn",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      endpointSelector: { matchLabels: { "paperclip.io/role": "agent" } },
      egress,
    },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/cilium-network-policy.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/cilium-network-policy.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/cilium-network-policy.test.ts
git commit -m "feat(plugin-kubernetes): CiliumNetworkPolicy for FQDN-based egress"
```

---

## Phase 9 — Tenant orchestrator (1 task)

### Task 10: ensureTenant — namespace + RBAC + quota + limit range + network policy

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/tenant-orchestrator.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/tenant-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/tenant-orchestrator.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ensureTenant } from "../../src/tenant-orchestrator.js";

function makeMockClients() {
  const calls: { kind: string; name: string; namespace?: string; body?: unknown }[] = [];
  function track(kind: string) {
    return vi.fn(async (...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { name?: string; namespace?: string; body?: unknown };
      calls.push({ kind, name: arg.name ?? "", namespace: arg.namespace, body: arg.body });
      // Throw 409 (already-exists) on the second invocation for the same kind+name pair
      // to simulate idempotent ensures.
      return { body: arg.body };
    });
  }
  return {
    calls,
    core: {
      createNamespace: track("Namespace"),
      readNamespacedServiceAccount: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedServiceAccount: track("ServiceAccount"),
      readNamespacedResourceQuota: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedResourceQuota: track("ResourceQuota"),
      readNamespacedLimitRange: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedLimitRange: track("LimitRange"),
      readNamespace: vi.fn().mockRejectedValue({ statusCode: 404 }),
    },
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedRole: track("Role"),
      readNamespacedRoleBinding: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedRoleBinding: track("RoleBinding"),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedNetworkPolicy: track("NetworkPolicy"),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
    },
  };
}

describe("ensureTenant", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "20", requestsCpu: "5", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "80Gi" },
  };

  it("creates all required resources in the correct order on a fresh tenant", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, baseInput);
    const order = clients.calls.map((c) => c.kind);
    expect(order).toEqual([
      "Namespace",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy", // deny-all
      "NetworkPolicy", // egress allow
    ]);
  });

  it("creates a CiliumNetworkPolicy instead of standard egress when egressMode=cilium", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    const cnpCall = clients.calls.find((c) => c.kind === "CiliumNetworkPolicy");
    expect(cnpCall).toBeDefined();
    // Should still create deny-all NetworkPolicy as baseline
    const npCalls = clients.calls.filter((c) => c.kind === "NetworkPolicy");
    expect(npCalls).toHaveLength(1);
    expect((npCalls[0].body as { metadata: { name: string } }).metadata.name).toBe("paperclip-deny-all");
  });

  it("applies serviceAccountAnnotations to the ServiceAccount", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
    });
    const saCall = clients.calls.find((c) => c.kind === "ServiceAccount");
    const sa = saCall!.body as { metadata: { annotations: Record<string, string> } };
    expect(sa.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123:role/paperclip");
  });

  it("skips creates that already exist (idempotency)", async () => {
    const clients = makeMockClients();
    // Mark namespace as existing
    clients.core.readNamespace.mockResolvedValue({ body: { metadata: { name: baseInput.namespace } } });
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/tenant-orchestrator.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/tenant-orchestrator.ts`**

```ts
import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";

export interface EnsureTenantInput {
  namespace: string;
  companyId: string;
  paperclipServerNamespace: string;
  serviceAccountAnnotations: Record<string, string>;
  egressMode: "standard" | "cilium";
  egressAllowFqdns: string[];
  egressAllowCidrs: string[];
  resourceQuota: {
    pods: string;
    requestsCpu: string;
    requestsMemory: string;
    limitsCpu: string;
    limitsMemory: string;
  };
}

const SERVICE_ACCOUNT_NAME = "paperclip-tenant-sa";
const ROLE_NAME = "paperclip-tenant-role";
const ROLE_BINDING_NAME = "paperclip-tenant-rb";
const RESOURCE_QUOTA_NAME = "paperclip-quota";
const LIMIT_RANGE_NAME = "paperclip-limits";

export async function ensureTenant(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  await ensureNamespace(clients, input);
  await ensureServiceAccount(clients, input);
  await ensureRole(clients, input);
  await ensureRoleBinding(clients, input);
  await ensureResourceQuota(clients, input);
  await ensureLimitRange(clients, input);
  await ensureNetworkPolicies(clients, input);
}

async function ensureNamespace(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespace({ name: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespace({
    body: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: input.namespace,
        labels: {
          "paperclip.io/company-id": input.companyId,
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
        },
      },
    },
  });
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedServiceAccount({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: SERVICE_ACCOUNT_NAME,
        namespace: input.namespace,
        annotations: input.serviceAccountAnnotations,
        labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
      },
    },
  });
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.rbac.createNamespacedRole({
    namespace: input.namespace,
    body: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: ROLE_NAME, namespace: input.namespace },
      rules: [
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
      ],
    },
  });
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.rbac.createNamespacedRoleBinding({
    namespace: input.namespace,
    body: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
      subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
    },
  });
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedResourceQuota({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: RESOURCE_QUOTA_NAME, namespace: input.namespace },
      spec: {
        hard: {
          pods: input.resourceQuota.pods,
          "requests.cpu": input.resourceQuota.requestsCpu,
          "requests.memory": input.resourceQuota.requestsMemory,
          "limits.cpu": input.resourceQuota.limitsCpu,
          "limits.memory": input.resourceQuota.limitsMemory,
        },
      },
    },
  });
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedLimitRange({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: LIMIT_RANGE_NAME, namespace: input.namespace },
      spec: {
        limits: [
          {
            type: "Container",
            max: { cpu: "4", memory: "8Gi" },
            min: { cpu: "100m", memory: "128Mi" },
            default: { cpu: "1", memory: "2Gi" },
            defaultRequest: { cpu: "250m", memory: "512Mi" },
          },
        ],
      },
    },
  });
}

async function ensureNetworkPolicies(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  // Always create deny-all baseline (works on standard NetworkPolicy regardless of CNI)
  const [denyAll, egressStd] = buildNetworkPolicyManifests({
    namespace: input.namespace,
    paperclipServerNamespace: input.paperclipServerNamespace,
    egressAllowCidrs: input.egressAllowCidrs,
  });

  await ensureNetworkPolicy(clients, input.namespace, denyAll);

  if (input.egressMode === "cilium") {
    const cnp = buildCiliumNetworkPolicyManifest({
      namespace: input.namespace,
      paperclipServerNamespace: input.paperclipServerNamespace,
      egressAllowFqdns: input.egressAllowFqdns,
      egressAllowCidrs: input.egressAllowCidrs,
    });
    await ensureCiliumNetworkPolicy(clients, input.namespace, cnp);
  } else {
    await ensureNetworkPolicy(clients, input.namespace, egressStd);
  }
}

async function ensureNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await clients.networking.readNamespacedNetworkPolicy({ name, namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.networking.createNamespacedNetworkPolicy({ namespace, body: manifest as never });
}

async function ensureCiliumNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await clients.custom.getNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name,
    });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.custom.createNamespacedCustomObject({
    group: "cilium.io",
    version: "v2",
    namespace,
    plural: "ciliumnetworkpolicies",
    body: manifest,
  });
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/tenant-orchestrator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/tenant-orchestrator.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/tenant-orchestrator.test.ts
git commit -m "feat(plugin-kubernetes): ensureTenant orchestrator (ns + RBAC + quota + np)"
```

---

## Phase 10 — Secret manager (1 task)

### Task 11: Per-run ephemeral Secret with owner references

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/secret-manager.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/secret-manager.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/secret-manager.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createPerRunSecret } from "../../src/secret-manager.js";

describe("createPerRunSecret", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    secretName: "r-abcd-env",
    runId: "r-abcd",
    ownerKind: "Job",
    ownerApiVersion: "batch/v1",
    ownerName: "r-abcd",
    ownerUid: "11111111-1111-1111-1111-111111111111",
    bootstrapToken: "tok-xyz",
    adapterEnv: { ANTHROPIC_API_KEY: "sk-test" },
  };

  it("creates a Secret with the correct name and namespace", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledOnce();
    const body = created[0].body as { metadata: { name: string; namespace: string } };
    expect(body.metadata.name).toBe("r-abcd-env");
    expect(body.metadata.namespace).toBe("paperclip-acme");
  });

  it("includes BOOTSTRAP_TOKEN and adapter env keys in stringData", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { stringData: Record<string, string> };
    expect(body.stringData.BOOTSTRAP_TOKEN).toBe("tok-xyz");
    expect(body.stringData.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("sets ownerReferences to the Sandbox for cascade delete", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { metadata: { ownerReferences: { uid: string; controller: boolean }[] } };
    expect(body.metadata.ownerReferences).toHaveLength(1);
    expect(body.metadata.ownerReferences[0].uid).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.metadata.ownerReferences[0].controller).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/secret-manager.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/secret-manager.ts`**

```ts
import type { KubeClients } from "./kube-client.js";

export interface CreatePerRunSecretInput {
  namespace: string;
  secretName: string;
  runId: string;
  ownerKind: string;          // e.g. "Job"
  ownerApiVersion: string;    // e.g. "batch/v1"
  ownerName: string;
  ownerUid: string;
  bootstrapToken: string;
  adapterEnv: Record<string, string>;
}

export async function createPerRunSecret(clients: KubeClients, input: CreatePerRunSecretInput): Promise<void> {
  await clients.core.createNamespacedSecret({
    namespace: input.namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: input.secretName,
        namespace: input.namespace,
        labels: {
          "paperclip.io/run-id": input.runId,
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
        },
        ownerReferences: [
          {
            apiVersion: input.ownerApiVersion,
            kind: input.ownerKind,
            name: input.ownerName,
            uid: input.ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      stringData: {
        BOOTSTRAP_TOKEN: input.bootstrapToken,
        ...input.adapterEnv,
      },
    },
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/secret-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/secret-manager.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/secret-manager.test.ts
git commit -m "feat(plugin-kubernetes): per-run ephemeral Secret with owner references"
```

---

## Phase 11 — Job orchestrator (1 task)

### Task 12: SandboxOrchestrator interface + Job-backed implementation

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/sandbox-orchestrator.ts` (interface)
- Create: `packages/plugins/sandbox-providers/kubernetes/src/job-orchestrator.ts` (Job-backed implementation)
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/job-orchestrator.test.ts`

**Why an interface layer:** Plugin.ts depends on `SandboxOrchestrator`, not directly on the Job functions. This is the explicit swap point: future backends (Kata-FC warm pool with pause/freeze; kubernetes-sigs/agent-sandbox CRD when it reaches Beta) are sibling files exporting an object that conforms to the same interface. To swap, change one import in plugin.ts.

- [ ] **Step 1: Write the failing test**

`test/unit/job-orchestrator.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createJob, deleteJob, getJobStatus, findPodForJob } from "../../src/job-orchestrator.js";

describe("createJob", () => {
  it("calls batch.createNamespacedJob with the manifest", async () => {
    const create = vi.fn().mockResolvedValue({ body: { metadata: { uid: "abc-uid" } } });
    const clients = { batch: { createNamespacedJob: create } };
    const jobManifest = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "r-1", namespace: "ns" }, spec: { template: {} } };
    const result = await createJob(clients as never, "ns", jobManifest);
    expect(create).toHaveBeenCalledWith({ namespace: "ns", body: jobManifest });
    expect(result.uid).toBe("abc-uid");
  });
});

describe("getJobStatus", () => {
  it("returns phase=Succeeded when succeeded count is 1", async () => {
    const get = vi.fn().mockResolvedValue({ body: { status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Succeeded");
    expect(status.complete).toBe(true);
  });

  it("returns phase=Failed when failed count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ body: { status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] } } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Failed");
    expect(status.reason).toBe("DeadlineExceeded");
  });

  it("returns phase=Running when active count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ body: { status: { active: 1 } } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Running");
  });

  it("returns phase=Pending when no active/succeeded/failed counters set", async () => {
    const get = vi.fn().mockResolvedValue({ body: { status: {} } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Pending");
  });
});

describe("findPodForJob", () => {
  it("lists pods by job-name label and returns the first running pod", async () => {
    const list = vi.fn().mockResolvedValue({ body: { items: [{ metadata: { name: "r-1-xyz" }, status: { phase: "Running" } }] } });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns", labelSelector: "job-name=r-1" }));
    expect(podName).toBe("r-1-xyz");
  });

  it("returns null when no pod is found", async () => {
    const list = vi.fn().mockResolvedValue({ body: { items: [] } });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(podName).toBeNull();
  });
});

describe("deleteJob", () => {
  it("calls batch.deleteNamespacedJob with foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { batch: { deleteNamespacedJob: del } };
    await deleteJob(clients as never, "ns", "r-1");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        name: "r-1",
        body: expect.objectContaining({ propagationPolicy: "Foreground" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/job-orchestrator.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3a: Define the interface in `src/sandbox-orchestrator.ts`**

```ts
import type { KubeClients } from "./kube-client.js";

export interface SandboxStatus {
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  complete: boolean;
  active: number;
  succeeded: number;
  failed: number;
  reason?: string;
  message?: string;
}

/**
 * Abstract interface over a sandbox runtime backend. The current implementation
 * is Job-backed (job-orchestrator.ts). Future backends slot in by exporting an
 * object conforming to this shape — e.g. a Kata-FC warm-pool backend that
 * additionally implements the optional pause/resume slots, or a CRD-backed
 * backend on kubernetes-sigs/agent-sandbox once it reaches Beta.
 */
export interface SandboxOrchestrator {
  /** Provision the sandbox. Returns the runtime's stable UID. */
  claim(
    clients: KubeClients,
    namespace: string,
    manifest: Record<string, unknown>,
  ): Promise<{ uid: string }>;

  /** Read current lifecycle phase. */
  getStatus(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<SandboxStatus>;

  /** Locate the pod backing this sandbox (or null if none exists yet). */
  findPod(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<string | null>;

  /** Read logs from the sandbox's pod. V1: post-completion read. */
  streamLogs(
    clients: KubeClients,
    namespace: string,
    podName: string,
    onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
  ): Promise<void>;

  /** Tear down the sandbox. Implementations MUST cascade-delete child resources. */
  release(clients: KubeClients, namespace: string, name: string): Promise<void>;

  /** Block until phase is Succeeded or Failed, or throw on timeout. */
  waitForCompletion(
    clients: KubeClients,
    namespace: string,
    name: string,
    opts: { timeoutMs: number; pollMs?: number },
  ): Promise<SandboxStatus>;

  // Optional warm-pool / Kata-FC extension slots. Job-backed implementation
  // does not provide these; runtimes that do (e.g. Kata-FC microVM pause)
  // implement them and acquire the warm-pool capability.
  // TODO: requires custom in-cluster controller for k8s — kubelet does not
  // expose pause/resume at the pod level. Add when warm-pool design lands.
  pause?(clients: KubeClients, namespace: string, name: string): Promise<void>;
  resume?(clients: KubeClients, namespace: string, name: string): Promise<void>;
}
```

- [ ] **Step 3b: Implement `src/job-orchestrator.ts`** as the Job-backed conformance

```ts
import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

export async function createJob(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.batch.createNamespacedJob({ namespace, body: manifest as never });
  const body = (result as { body?: { metadata?: { uid?: string } } }).body;
  const uid = body?.metadata?.uid;
  if (!uid) throw new Error("Job created without a UID");
  return { uid };
}

// JobStatus is the Job-backed shape of SandboxStatus — they're structurally identical.
export type JobStatus = SandboxStatus;

export async function getJobStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<JobStatus> {
  const result = await clients.batch.readNamespacedJobStatus({ namespace, name });
  const body = (result as { body?: Record<string, unknown> }).body ?? {};
  const status = (body.status as Record<string, unknown>) ?? {};
  const active = (status.active as number) ?? 0;
  const succeeded = (status.succeeded as number) ?? 0;
  const failed = (status.failed as number) ?? 0;
  const conditions = (status.conditions as { type: string; status: string; reason?: string; message?: string }[]) ?? [];
  const completed = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
  if (failedCond || failed > 0) {
    return { phase: "Failed", complete: false, active, succeeded, failed, reason: failedCond?.reason, message: failedCond?.message };
  }
  if (completed || succeeded > 0) {
    return { phase: "Succeeded", complete: true, active, succeeded, failed };
  }
  if (active > 0) {
    return { phase: "Running", complete: false, active, succeeded, failed };
  }
  return { phase: "Pending", complete: false, active, succeeded, failed };
}

export async function findPodForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const items = ((result as { body?: { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] } }).body?.items) ?? [];
  // Prefer a running pod; otherwise return the first one we see
  const running = items.find((p) => p.status?.phase === "Running");
  return (running ?? items[0])?.metadata?.name ?? null;
}

export async function streamPodLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // For V1, read-once after job completion (Job's logs are stable post-completion since pod isn't restarting).
  // True streaming (follow=true) can come in a future iteration if needed.
  const result = await clients.core.readNamespacedPodLog({ namespace, name: podName });
  const text = ((result as { body?: string }).body) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteJob(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.batch.deleteNamespacedJob({
    namespace,
    name,
    body: { propagationPolicy: "Foreground" },
  });
}

export async function waitForJobCompletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") return status;
    await sleep(pollMs);
  }
  throw new Error(`Job ${namespace}/${name} did not complete within ${opts.timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job-backed conformance to SandboxOrchestrator. Plugin.ts imports THIS value
 * (the swap point) — to use a different backend, swap this import for another
 * module exposing a SandboxOrchestrator-shaped default export.
 */
export const jobOrchestrator: SandboxOrchestrator = {
  claim: createJob,
  getStatus: getJobStatus,
  findPod: findPodForJob,
  streamLogs: streamPodLogs,
  release: deleteJob,
  waitForCompletion: waitForJobCompletion,
};
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/job-orchestrator.test.ts`
Expected: PASS (7 tests). The interface declaration in `sandbox-orchestrator.ts` is pure types and adds no test surface; the Job-backed implementation's behavior is fully covered by the existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/sandbox-orchestrator.ts \
        packages/plugins/sandbox-providers/kubernetes/src/job-orchestrator.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/job-orchestrator.test.ts
git commit -m "feat(plugin-kubernetes): SandboxOrchestrator interface + Job-backed implementation"
```

---

## Phase 12 — Plugin manifest (1 task)

### Task 13: PaperclipPluginManifestV1

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/manifest.ts`

- [ ] **Step 1: Write the manifest**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.kubernetes-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kubernetes Sandbox Provider",
  description:
    "First-party sandbox provider plugin that runs agents as one-shot batch/v1 Jobs in per-tenant Kubernetes namespaces. Uses only stable k8s APIs — no CRD prerequisite.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "kubernetes",
      kind: "sandbox_provider",
      displayName: "Kubernetes",
      description:
        "Dispatches agent runs as one-shot Kubernetes Jobs in per-tenant namespaces. Requires only a kubeconfig (or in-cluster ServiceAccount) and a target cluster running k8s 1.27+ — no CRDs or operators to install.",
      configSchema: {
        type: "object",
        properties: {
          inCluster: {
            type: "boolean",
            description:
              "When true, the plugin uses the in-pod ServiceAccount credentials. Requires paperclip-server to be running inside the target cluster.",
          },
          kubeconfig: {
            type: "string",
            format: "secret-ref",
            description:
              "Inline kubeconfig YAML. Paste a kubeconfig or an existing Paperclip secret reference; pasted values are stored as company secrets.",
          },
          kubeconfigSecretRef: {
            type: "string",
            description: "Reference to an existing Paperclip secret containing a kubeconfig YAML.",
          },
          namespacePrefix: {
            type: "string",
            description: "Prefix for the per-company tenant namespace (default: paperclip-).",
          },
          companySlug: {
            type: "string",
            description: "Override the auto-derived company slug used in the tenant namespace name.",
          },
          imageRegistry: {
            type: "string",
            description: "Override the default registry for agent runtime images (default: ghcr.io/paperclipai).",
          },
          imageAllowList: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns of allowed `target.imageOverride` values. Empty list = no override permitted.",
          },
          imagePullSecrets: {
            type: "array",
            items: { type: "string" },
            description: "Names of pre-created Docker image pull secrets in the tenant namespace.",
          },
          egressAllowFqdns: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional FQDNs to allow egress to from agent pods. Adapter-default FQDNs (e.g. api.anthropic.com) are added automatically.",
          },
          egressAllowCidrs: {
            type: "array",
            items: { type: "string" },
            description: "Additional CIDRs to allow egress to from agent pods.",
          },
          egressMode: {
            type: "string",
            enum: ["standard", "cilium"],
            description: "Network policy mode. `cilium` enables FQDN-based egress filtering via CiliumNetworkPolicy.",
          },
          runtimeClassName: {
            type: "string",
            description:
              "Optional RuntimeClass for pod isolation (e.g. `kata-fc` for Firecracker-backed microVMs). Cluster must have the RuntimeClass installed.",
          },
          serviceAccountAnnotations: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Annotations applied to the per-tenant ServiceAccount (e.g. `eks.amazonaws.com/role-arn` for IRSA).",
          },
          jobTtlSecondsAfterFinished: {
            type: "integer",
            minimum: 0,
            description: "Seconds after a Sandbox completes before it is garbage-collected (default: 900).",
          },
          podActivityDeadlineSec: {
            type: "integer",
            minimum: 1,
            description: "Hard ceiling on a single run's wall-clock time (default: 3600).",
          },
        },
        anyOf: [
          { required: ["inCluster"] },
          { required: ["kubeconfig"] },
          { required: ["kubeconfigSecretRef"] },
        ],
      },
    },
  ],
};

export default manifest;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no TS errors).

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/manifest.ts
git commit -m "feat(plugin-kubernetes): plugin manifest + driver config schema"
```

---

## Phase 13 — Plugin lifecycle wiring (1 task)

### Task 14: definePlugin with PluginEnvironment* hooks

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/src/plugin.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/unit/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/plugin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";

describe("plugin", () => {
  it("exports the kubernetes driver", () => {
    expect(plugin.manifest.id).toBe("paperclip.kubernetes-sandbox-provider");
    expect(plugin.manifest.environmentDrivers?.[0].driverKey).toBe("kubernetes");
  });

  it("validateConfig accepts inCluster=true config", async () => {
    const result = await plugin.environmentDriver!.validateConfig({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
  });

  it("validateConfig rejects missing auth", async () => {
    const result = await plugin.environmentDriver!.validateConfig({
      driverKey: "kubernetes",
      config: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/requires one of `inCluster`/);
  });

  it("validateConfig normalizes defaults", async () => {
    const result = await plugin.environmentDriver!.validateConfig({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toEqual(
      expect.objectContaining({
        namespacePrefix: "paperclip-",
        egressMode: "standard",
        jobTtlSecondsAfterFinished: 900,
        podActivityDeadlineSec: 3600,
      }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm test test/unit/plugin.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `src/plugin.ts`**

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentLease,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
} from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import {
  kubernetesProviderConfigSchema,
  parseKubernetesProviderConfig,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { getAdapterDefaults } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import {
  createJob,
  deleteJob,
  findPodForJob,
  getJobStatus,
  streamPodLogs,
  waitForJobCompletion,
} from "./job-orchestrator.js";
import { deriveCompanySlug, deriveNamespaceName, newRunUlidDns, paperclipLabels } from "./utils.js";

const PAPERCLIP_SERVER_NAMESPACE = "paperclip";

const plugin = definePlugin({
  manifest,
  environmentDriver: {
    async validateConfig(
      params: PluginEnvironmentValidateConfigParams,
    ): Promise<PluginEnvironmentValidationResult> {
      const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
      if (!parsed.success) {
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => i.message),
        };
      }
      return {
        ok: true,
        normalizedConfig: parsed.data as Record<string, unknown>,
      };
    },

    async probe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
      const config = parseKubernetesProviderConfig(params.config);
      try {
        const kc = createKubeConfig(config);
        const clients = makeKubeClients(kc);
        const ns = deriveTenantNamespace(config, params.companyId ?? "default", params.companyName);
        // Simple reachability check — list pods in (probably nonexistent) tenant ns.
        await clients.core.listNamespacedPod({ namespace: ns });
        return { ok: true, summary: `Kubernetes API reachable; tenant namespace = ${ns}` };
      } catch (err) {
        return {
          ok: false,
          summary: `Kubernetes probe failed: ${(err as Error).message}`,
          metadata: { error: (err as Error).message },
        };
      }
    },

    async acquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
      const config = parseKubernetesProviderConfig(params.config);
      const kc = createKubeConfig(config);
      const clients = makeKubeClients(kc);
      const adapterType = params.adapterType ?? "claude_local";
      const defaults = getAdapterDefaults(adapterType);
      const companyId = params.companyId ?? "00000000-0000-0000-0000-000000000000";
      const namespace = deriveTenantNamespace(config, companyId, params.companyName);

      await ensureTenant(clients, {
        namespace,
        companyId,
        paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
        serviceAccountAnnotations: config.serviceAccountAnnotations,
        egressMode: config.egressMode,
        egressAllowFqdns: [...defaults.allowFqdns, ...config.egressAllowFqdns],
        egressAllowCidrs: config.egressAllowCidrs,
        resourceQuota: {
          pods: "20",
          requestsCpu: "5",
          requestsMemory: "20Gi",
          limitsCpu: "20",
          limitsMemory: "80Gi",
        },
      });

      const ulid = newRunUlidDns();
      const jobName = `r-${ulid}`;
      const secretName = `${jobName}-env`;

      const image = resolveImage(
        { imageOverride: null },
        defaults,
        { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
      );

      const jobManifest = buildJobManifest({
        namespace,
        jobName,
        adapterType,
        image,
        envSecretName: secretName,
        serviceAccountName: "paperclip-tenant-sa",
        labels: paperclipLabels({
          runId: params.runId,
          agentId: params.agentId ?? "unknown",
          companyId,
          adapterType,
        }),
        resources: {
          requests: config.defaultResources?.requests as { cpu?: string; memory?: string } | undefined,
          limits: config.defaultResources?.limits as { cpu?: string; memory?: string } | undefined,
        },
        runtimeClassName: config.runtimeClassName,
        activeDeadlineSec: config.podActivityDeadlineSec,
        ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
        imagePullSecrets: config.imagePullSecrets,
      });

      const { uid } = await createJob(clients, namespace, jobManifest);

      await createPerRunSecret(clients, {
        namespace,
        secretName,
        runId: params.runId,
        ownerKind: "Job",
        ownerApiVersion: "batch/v1",
        ownerName: jobName,
        ownerUid: uid,
        bootstrapToken: params.bootstrapToken ?? "",
        adapterEnv: extractAdapterEnv(params.env ?? {}, defaults.envKeys),
      });

      const metadata: KubernetesLeaseMetadata = {
        namespace,
        jobName,
        podName: null,
        secretName,
        phase: "Pending",
      };
      return { providerLeaseId: jobName, metadata: metadata as unknown as Record<string, unknown> };
    },

    async execute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
      const config = parseKubernetesProviderConfig(params.config);
      const kc = createKubeConfig(config);
      const clients = makeKubeClients(kc);
      const metadata = params.lease.metadata as unknown as KubernetesLeaseMetadata;
      // Wait for the Job's pod to reach a terminal state.
      const status = await waitForJobCompletion(clients, metadata.namespace, metadata.jobName, {
        timeoutMs: (params.timeoutMs ?? config.podActivityDeadlineSec * 1000) + 30_000,
      });
      // Stream logs from the pod (post-completion read).
      const podName = await findPodForJob(clients, metadata.namespace, metadata.jobName);
      let stdout = "";
      if (podName) {
        await streamPodLogs(clients, metadata.namespace, podName, async (_stream, text) => { stdout += text; });
      }
      const exitCode = status.phase === "Succeeded" ? 0 : 1;
      return {
        exitCode,
        signal: null,
        timedOut: status.phase === "Failed" && status.reason === "DeadlineExceeded",
        stdout,
        stderr: "",
        metadata: {
          jobPhase: status.phase,
          jobReason: status.reason,
          jobMessage: status.message,
        },
      };
    },

    async releaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
      if (!params.providerLeaseId) return;
      const config = parseKubernetesProviderConfig(params.config);
      const kc = createKubeConfig(config);
      const clients = makeKubeClients(kc);
      const metadata = params.leaseMetadata as KubernetesLeaseMetadata | undefined;
      const namespace = metadata?.namespace ?? deriveTenantNamespace(config, params.companyId ?? "default", params.companyName);
      await deleteJob(clients, namespace, params.providerLeaseId);
    },
  },
});

function deriveTenantNamespace(
  config: KubernetesProviderConfig,
  companyId: string,
  companyName?: string,
): string {
  if (config.companySlug) return deriveNamespaceName(config.namespacePrefix, config.companySlug);
  const slug = deriveCompanySlug(companyName ?? companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

function extractAdapterEnv(env: Record<string, string>, envKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of envKeys) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

export default plugin;
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm test test/unit/plugin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/src/plugin.ts \
        packages/plugins/sandbox-providers/kubernetes/test/unit/plugin.test.ts
git commit -m "feat(plugin-kubernetes): definePlugin lifecycle wiring (validate, probe, acquire, release)"
```

---

## Phase 14 — Build + lint hygiene (1 task)

### Task 15: Build the package and confirm it produces clean dist

- [ ] **Step 1: Run build**

Run: `cd packages/plugins/sandbox-providers/kubernetes && pnpm build`
Expected: `dist/` produced with `index.js`, `worker.js`, `plugin.js`, `manifest.js`, etc.

- [ ] **Step 2: Run all unit tests one more time**

Run: `pnpm test`
Expected: PASS — all unit suites green.

- [ ] **Step 3: Confirm no dist files are tracked**

Run: `git status`
Expected: `dist/` is gitignored; nothing to add.

- [ ] **Step 4: Commit `.gitignore` entry if missing**

Check that `packages/plugins/sandbox-providers/kubernetes/.gitignore` (or the workspace `.gitignore`) excludes `dist/`. If a local `.gitignore` is needed:

```bash
echo -e "dist/\nnode_modules/\n*.tsbuildinfo\n" > packages/plugins/sandbox-providers/kubernetes/.gitignore
git add packages/plugins/sandbox-providers/kubernetes/.gitignore
git commit -m "chore(plugin-kubernetes): gitignore for dist + tsbuildinfo"
```

Otherwise (already covered), skip.

---

## Phase 15 — Integration tests against kind (1 task)

### Task 16: End-to-end run against the existing kind cluster

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/test/integration/_kind-harness.ts`
- Create: `packages/plugins/sandbox-providers/kubernetes/test/integration/end-to-end-run.test.ts`

**Prerequisites verified before running:**
- kind cluster `kind-paperclip` exists (created during the 2026-05-12 spike — or run `kind create cluster --name paperclip` fresh)
- `RUN_K8S_INTEGRATION_TESTS=1` environment variable set when running tests
- **No agent-sandbox or other CRD prerequisite** — uses only standard Kubernetes APIs (batch/v1 Job + v1 Pod/Secret/etc.)

- [ ] **Step 1: Create the harness**

`test/integration/_kind-harness.ts`:

```ts
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KIND_CONTEXT = "kind-paperclip";

export function readKindKubeconfig(): string {
  return readFileSync(join(homedir(), ".kube", "config"), "utf-8");
}

export function kubectl(args: string): string {
  return execSync(`kubectl --context ${KIND_CONTEXT} ${args}`, { encoding: "utf-8" });
}

export function deleteNamespaceIfExists(namespace: string): void {
  try {
    kubectl(`delete namespace ${namespace} --wait=true --timeout=60s --ignore-not-found`);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/integration/end-to-end-run.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import plugin from "../../src/plugin.js";
import { deleteNamespaceIfExists, kubectl, readKindKubeconfig } from "./_kind-harness.js";

const NAMESPACE = "paperclip-spike-e2e";

describe("plugin-kubernetes end-to-end", () => {
  beforeAll(() => {
    if (process.env.RUN_K8S_INTEGRATION_TESTS !== "1") return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  afterAll(() => {
    if (process.env.RUN_K8S_INTEGRATION_TESTS !== "1") return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  it.runIf(process.env.RUN_K8S_INTEGRATION_TESTS === "1")(
    "acquires a lease that creates a Job, executes the pod to completion, then releases it",
    async () => {
      // Pre-load alpine into kind, tagged as the adapter-default image so the
      // plugin's resolveImage returns it without imageOverride. This avoids
      // needing to publish real agent-runtime images to ghcr.io for the spike.
      // (Run BEFORE this test:
      //   docker pull --platform=linux/amd64 alpine:3.20
      //   docker tag alpine:3.20 ghcr.io/paperclipai/agent-runtime-claude:v1
      //   kind load docker-image ghcr.io/paperclipai/agent-runtime-claude:v1 --name paperclip
      // )
      const kubeconfig = readKindKubeconfig();
      const config = {
        inCluster: false,
        kubeconfig,
        companySlug: "spike-e2e",
        imageAllowList: [] as string[],
        podActivityDeadlineSec: 60,
      };

      const lease = await plugin.environmentDriver!.acquireLease({
        driverKey: "kubernetes",
        config,
        runId: "r-test-e2e",
        agentId: "agent-test",
        adapterType: "claude_local",
        companyId: "11111111-1111-1111-1111-111111111111",
        companyName: "SpikeE2E",
        env: { ANTHROPIC_API_KEY: "sk-fake" },
        bootstrapToken: "bootstrap-test",
      } as never);

      expect(lease.providerLeaseId).toMatch(/^r-/);

      // Verify the Job exists in the tenant namespace
      const jobs = kubectl(`get jobs -n ${NAMESPACE} -o name`);
      expect(jobs).toContain(lease.providerLeaseId);

      // Verify the tenant namespace has the expected supporting resources
      const all = kubectl(`get sa,role,rolebinding,resourcequota,limitrange,networkpolicy -n ${NAMESPACE} -o name`);
      expect(all).toContain("serviceaccount/paperclip-tenant-sa");
      expect(all).toContain("role.rbac.authorization.k8s.io/paperclip-tenant-role");
      expect(all).toContain("rolebinding.rbac.authorization.k8s.io/paperclip-tenant-rb");
      expect(all).toContain("resourcequota/paperclip-quota");
      expect(all).toContain("limitrange/paperclip-limits");
      expect(all).toContain("networkpolicy.networking.k8s.io/paperclip-deny-all");
      expect(all).toContain("networkpolicy.networking.k8s.io/paperclip-egress-allow");

      // Release — should cascade-delete the Pod and Secret via owner references
      await plugin.environmentDriver!.releaseLease({
        driverKey: "kubernetes",
        config,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
        companyId: "11111111-1111-1111-1111-111111111111",
        companyName: "SpikeE2E",
      } as never);
    },
    180_000,
  );
});
```

- [ ] **Step 3: Run the integration test — expect FAIL**

Run: `RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/end-to-end-run.test.ts`
Expected: **FAIL initially** — the plugin tries to pull `ghcr.io/paperclipai/agent-runtime-claude:v1` which doesn't exist. This validates the plumbing.

(NOTE: This is a deliberate-failure step. The next step shows how to make it pass by using a public image override via the imageAllowList + a test-time adapter-defaults override. If you want full pass-criteria for V1 of this plan, modify the test to use a pre-loaded image into kind.)

- [ ] **Step 4: Make the test pass by pre-loading a public test image**

The simplest pass path for V1: pre-load alpine into kind with the expected name. Run before invoking the test:

```bash
docker pull --platform=linux/amd64 alpine:3.20
docker tag alpine:3.20 ghcr.io/paperclipai/agent-runtime-claude:v1
kind load docker-image ghcr.io/paperclipai/agent-runtime-claude:v1 --name paperclip
```

Then re-run the integration test:

```bash
RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/end-to-end-run.test.ts
```

Expected: PASS. The Job materializes, its Pod uses ImagePullPolicy=IfNotPresent to find the pre-loaded image, the alpine container runs, the Job reaches Succeeded, the lease is acquired + released cleanly, and the Job + per-run Secret are cascade-deleted on release.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/test/integration/_kind-harness.ts \
        packages/plugins/sandbox-providers/kubernetes/test/integration/end-to-end-run.test.ts
git commit -m "test(plugin-kubernetes): end-to-end integration test against kind cluster"
```

---

## Phase 16 — Documentation (1 task)

### Task 17: README for operators

**Files:**
- Create: `packages/plugins/sandbox-providers/kubernetes/README.md`
- Create: `packages/plugins/sandbox-providers/kubernetes/manifests/operator-prerequisites.yaml`

- [ ] **Step 1: Create the README**

```markdown
# @paperclipai/plugin-kubernetes

First-party Paperclip sandbox-provider plugin that runs agents as per-tenant Kubernetes `Job`s. Uses only stable Kubernetes APIs (batch/v1, v1, rbac/v1, networking/v1) — no CRD prerequisites, no extra controllers to install.

## Prerequisites

1. A Kubernetes cluster (kind, minikube, k3s, EKS, GKE, AKS — anything 1.21+)
2. Paperclip-server (any version that supports the plugin SDK V1) — either running inside the cluster (recommended) or outside with reachable kubeconfig.

> **Why not `kubernetes-sigs/agent-sandbox`?** It's a great CNCF project but currently v1alpha1 with breaking changes still landing (e.g. issue #746). This plugin uses stable Kubernetes `Job` semantics instead, providing the same one-shot ephemeral lifecycle without the alpha-stage risk. Once agent-sandbox reaches v1beta1, we may add it as an optional backend for users who want warm pools / templates / pause-resume.

## Installation

```bash
paperclipai plugin install @paperclipai/plugin-kubernetes
```

Or, for local development:

```bash
paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/kubernetes
```

## Configuration

Create a `sandbox` environment with `driver: kubernetes`. Required fields (one of):

- `inCluster: true` — use the in-pod ServiceAccount credentials (when paperclip-server runs inside the same cluster).
- `kubeconfig: <YAML>` — inline kubeconfig (stored as a company secret).
- `kubeconfigSecretRef: <secret-uuid>` — reference to an existing Paperclip secret.

Optional fields: `namespacePrefix`, `imageRegistry`, `imageAllowList`, `egressAllowFqdns`, `egressAllowCidrs`, `egressMode` (`standard` or `cilium`), `runtimeClassName`, `serviceAccountAnnotations`, `jobTtlSecondsAfterFinished`, `podActivityDeadlineSec`.

Full schema in the plugin manifest (`src/manifest.ts`).

## What gets created in your cluster

For each company that runs agents:

```
Namespace          paperclip-{companySlug}
ServiceAccount     paperclip-tenant-sa
Role               paperclip-tenant-role
RoleBinding        paperclip-tenant-rb
ResourceQuota      paperclip-quota
LimitRange         paperclip-limits
NetworkPolicy      paperclip-deny-all
NetworkPolicy      paperclip-egress-allow      (or CiliumNetworkPolicy if egressMode=cilium)
```

For each agent run:

```
Job                r-{ulid}        (backoffLimit: 0, ttlSecondsAfterFinished: 900s default)
Pod                r-{ulid}-...   (owned by Job; cascade-deleted)
Secret             r-{ulid}-env   (owned by Job; cascade-deleted)
```

## Security baseline

Every agent pod is:

- non-root (uid/gid 1000), `runAsNonRoot: true`
- drop ALL capabilities, `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` with explicit `emptyDir` mounts for `/workspace`, `/home/paperclip`, `/home/paperclip/.cache`, `/tmp`
- `seccompProfile: RuntimeDefault`
- Tini as PID 1 (reaps zombies, forwards signals)
- `fsGroupChangePolicy: OnRootMismatch` (fast PVC startup)
- `automountServiceAccountToken: true` (for the agent shim's paperclip-server callback)

Plus per-namespace `pod-security.kubernetes.io/enforce: restricted` and a deny-all NetworkPolicy baseline with explicit egress allow-list.

## Optional Kata-FC microVM isolation

For stronger isolation, install [Kata Containers](https://github.com/kata-containers/kata-containers) with the Firecracker hypervisor, then set `runtimeClassName: kata-fc` in the plugin config. Each agent pod will run inside a Firecracker microVM. Requires nested-virt-capable nodes (bare-metal or specific cloud instance types).

## Lessons learned (from openclaw-operator)

This plugin adopts patterns from `openclaw-rocks/openclaw-operator`:

- Tini PID 1 (issue #471 — zombie helper processes)
- Read-only rootFS with explicit writable mounts (issue #456 — ~/.config not writable)
- Strategic merge on reconcile (issue #446 — preserve third-party annotations)
- Multi-storage-class testing (issue #448 — `local-path-provisioner` differences)
- Image version compat matrix (issue #462 — runtime deps cannot resolve after upgrade)
```

- [ ] **Step 2: Create the operator prerequisites manifest**

`manifests/operator-prerequisites.yaml`:

```yaml
# This plugin uses only stable Kubernetes APIs. No CRD installation is required.
#
# Minimum cluster version: Kubernetes 1.21+ (for fsGroupChangePolicy and seccompProfile)
# Recommended: 1.27+ (Pod Security Standards namespace labels are stable)
#
# Optional: kubernetes-sigs/agent-sandbox (when it reaches v1beta1) as an alternative
# backend for warm pools / templates / pause-resume. Not currently used.
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/sandbox-providers/kubernetes/README.md \
        packages/plugins/sandbox-providers/kubernetes/manifests/operator-prerequisites.yaml
git commit -m "docs(plugin-kubernetes): operator README and prerequisites manifest"
```

---

## Phase 17 — Final integration with paperclip-server (1 task)

### Task 18: Smoke test: install plugin into a running paperclip-server, configure an environment, verify dispatch

This task isn't TDD — it's a manual sanity-check that the package end-to-end works against a real paperclip-server instance. Future work may automate this in CI.

- [ ] **Step 1: Build the plugin**

```bash
cd packages/plugins/sandbox-providers/kubernetes
pnpm install --ignore-workspace
pnpm build
```

- [ ] **Step 2: Start a paperclip-server in dev mode**

In a separate terminal:

```bash
cd /path/to/paperclip
export PAPERCLIP_HOME=/tmp/paperclip-smoke
export PAPERCLIP_INSTANCE_ID=smoke
export PAPERCLIP_DEPLOYMENT_MODE=local_trusted
pnpm --filter @paperclipai/server dev
```

Wait for "Server listening on 127.0.0.1:3100".

- [ ] **Step 3: Install the plugin via CLI**

```bash
pnpm paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/kubernetes --api-base http://127.0.0.1:3100
```

Expected: `✓ Installed paperclip.kubernetes-sandbox-provider v0.1.0 (ready)`

- [ ] **Step 4: Create a company and a kubernetes environment via API**

```bash
CO_ID=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"SmokeCo"}' \
  http://127.0.0.1:3100/api/companies | jq -r '.id')

KUBECONFIG_CONTENT=$(cat ~/.kube/config | jq -Rs .)

curl -s -X POST -H "Content-Type: application/json" \
  -d "{
    \"name\": \"k8s-sandbox\",
    \"driver\": \"sandbox\",
    \"config\": {
      \"provider\": \"kubernetes\",
      \"kubeconfig\": $KUBECONFIG_CONTENT,
      \"companySlug\": \"smoke\",
      \"imageAllowList\": [\"ghcr.io/paperclipai/agent-runtime-claude:v1\"]
    }
  }" \
  http://127.0.0.1:3100/api/companies/$CO_ID/environments | jq
```

Expected: `HTTP 201` with the new environment row.

- [ ] **Step 5: Probe the environment**

```bash
ENV_ID=$(curl -s http://127.0.0.1:3100/api/companies/$CO_ID/environments | jq -r '.[0].id')
curl -s -X POST -d '{}' -H "Content-Type: application/json" \
  http://127.0.0.1:3100/api/environments/$ENV_ID/probe | jq
```

Expected: `{"ok": true, "driver": "sandbox", "summary": "Kubernetes API reachable; tenant namespace = paperclip-smoke"}` (or similar).

- [ ] **Step 6: Verify the tenant namespace was provisioned**

```bash
kubectl --context kind-paperclip get namespace paperclip-smoke
kubectl --context kind-paperclip get all,networkpolicy,resourcequota,limitrange -n paperclip-smoke
```

Expected:
- Namespace `paperclip-smoke` exists
- ServiceAccount `paperclip-tenant-sa`
- Role `paperclip-tenant-role`, RoleBinding `paperclip-tenant-rb`
- ResourceQuota `paperclip-quota`, LimitRange `paperclip-limits`
- NetworkPolicies `paperclip-deny-all`, `paperclip-egress-allow`

- [ ] **Step 7: Tear down for next session**

```bash
kubectl --context kind-paperclip delete namespace paperclip-smoke
kill $(jobs -p)
```

- [ ] **Step 8: Document the result**

In the PR description (or a SMOKE.md file), record:
- Date + git SHA + target k8s server version (from `kubectl version --short`)
- Output of `kubectl get all -n paperclip-smoke`
- Probe response
- Time-to-acquire-lease (target: <30s on kind)

---

## Self-review checklist (auto-applied by the plan writer)

1. **Spec coverage:**
   - §"Architecture overview" → Tasks 1, 12, 13, 14
   - §"Project structure" → Task 1 establishes the layout; subsequent tasks fill each file
   - §"Plugin config schema" → Task 2
   - §"Pod security baseline" → Task 7
   - §"Tenant namespace setup" → Task 10
   - §"Per-run pod assembly" → Task 7 + Task 14
   - §"Per-run secret + env injection" → Task 11
   - §"PluginEnvironment* lifecycle" → Task 14
   - §"Best-practice checklist" → Tasks 7 (Tini, readOnlyRootFS, fsGroupChangePolicy), 10 (deny-all + RBAC), 11 (ownerReferences cascade-delete), 17 (README documents the rest)
   - §"Failure modes and recovery" → Task 14 (try/catch around probe), Task 16 (integration test surfaces real failures)
   - §"Testing strategy" → Tasks 2-14 (unit), 16 (integration), 18 (manual smoke)
   - §"Migration from M-stack" → Not a task; documented in spec §5
   - §"Out of scope" → Explicitly deferred; no tasks needed
   - §"Open questions for review" → To be answered in the PR description, not the plan

2. **Placeholder scan:** No TBD/TODO/"add appropriate error handling"/"similar to Task N" present.

3. **Type consistency:** Method names match across tasks:
   - `parseKubernetesProviderConfig` defined in Task 2, used in Task 14
   - `getAdapterDefaults` defined in Task 3, used in Task 14
   - `resolveImage` defined in Task 4, used in Task 14
   - `createKubeConfig`, `makeKubeClients` defined in Task 5, used in Task 14
   - `paperclipLabels`, `newRunUlidDns`, `deriveCompanySlug`, `deriveNamespaceName` defined in Task 6, used in Task 14
   - `buildJobManifest` defined in Task 7, used in Task 14
   - `buildNetworkPolicyManifests` defined in Task 8, used in Task 10
   - `buildCiliumNetworkPolicyManifest` defined in Task 9, used in Task 10
   - `ensureTenant` defined in Task 10, used in Task 14
   - `createPerRunSecret` defined in Task 11, used in Task 14
   - `createJob`, `getJobStatus`, `findPodForJob`, `streamPodLogs`, `deleteJob`, `waitForJobCompletion` defined in Task 12, used in Task 14
   - `KubernetesProviderConfig`, `KubernetesLeaseMetadata` types defined in Task 2, used throughout

All cross-references verified consistent.

---

## Execution handoff

Plan complete. Total: **18 tasks** across **17 phases**, with TDD steps for every code task.

**Estimated effort:** ~2-3 working days for a subagent dispatched per task, ~3-5 working days for inline execution by a human.
