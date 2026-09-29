# `@paperclipai/plugin-daytona`

Published Daytona sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn for Daytona's SDK dependencies.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-daytona
```

The host plugin installer runs `npm install` into the managed plugin directory, so transitive dependencies such as `@daytonaio/sdk` are pulled in during installation.

## Configuration

Configure Daytona from `Instance Settings -> Environments`, not from the plugin's plugin page.

- Put the Daytona API key on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys as company secrets.
- `DAYTONA_API_KEY` remains an optional host-level fallback when an environment omits the key.
- Optional `apiUrl` and `target` settings map directly to the Daytona SDK/client configuration. If `apiUrl` is omitted, the Daytona SDK uses its default endpoint.

Notes:

- The current published Daytona SDK package is `@daytonaio/sdk`.
- The driver supports both `snapshot`-based and `image`-based sandbox creation. If both are set, validation rejects the config as ambiguous.
- Each cold create uses a unique provider name and ownership labels. If creation fails after Daytona has allocated a sandbox, the driver looks up that exact name, checks every ownership label, and waits for deletion. Failed, missing, or timed-out lookups and failed deletions report unconfirmed cleanup with the provider name; they never return a usable lease. A missing name lookup after an uncertain create is not proof that a delayed provider request cannot create a resource.
- For plugin-backed sandbox lease acquisition, unresolved creation cleanup crosses the worker RPC as a validated ownership envelope. The host records `pending_cleanup` before retrying deletion. If only a creation name is known, the provider first returns an ownership-verified sandbox ID without deleting it. The host saves that observation before authorizing deletion. Its existing cleanup sweep and durable spool preserve retries across controller restarts and environment deletion. A missing observed ID confirms cleanup after a lost deletion reply or database update; a name that has never been observed remains unresolved. Provider exceptions and resolved credentials are excluded from that envelope. This requires the matching host and plugin SDK update; probe and custom-image interactive-setup calls still report unconfirmed immediate cleanup without this lease-recovery path.
- Reusable leases map to Daytona stop/start semantics. Non-reusable leases are deleted on release. A provider-resolved `target` does not change the identity of an existing sandbox. Release closes the same scoped lease that a later sentinel-verified resume reopens.
- A sandbox record can survive the loss of its underlying container. Resume treats it as expired only when a fresh provider read confirms the exact missing-container error for that sandbox and marks it unrecoverable. Unknown errors and failed confirmation reads preserve the lease. The host still requires a verified native-runner backup before replacement.

## Local development

```bash
cd packages/plugins/sandbox-providers/daytona
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
