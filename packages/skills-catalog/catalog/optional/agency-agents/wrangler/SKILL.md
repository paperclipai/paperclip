---
name: "wrangler"
description: "Run or troubleshoot Wrangler CLI commands and configure Worker projects for local development, deployment, and Cloudflare resource management."
key: "paperclipai/optional/agency-agents/wrangler"
recommendedForRoles:
  - "engineer"
  - "operations"
tags:
  - "agency-agents"
  - "engineer"
  - "operations"
  - "wrangler"
defaultInstall: false
---
# Wrangler CLI

Use the project's Wrangler version and retrieve the relevant documentation before writing commands or configuration. CLI flags and configuration fields change; do not rely on memorized examples.

## Inspect the Project

- Find the package manager, installed Wrangler version, package scripts, framework, and Wrangler config. Run commands through the project's scripts or package manager so they use its local version. Install dependencies using the existing lockfile when needed; do not silently upgrade Wrangler to match current docs. If Wrangler is not a dependency, follow the [installation guide](https://developers.cloudflare.com/workers/wrangler/install-and-update/) to add it locally.
- Identify the config used by the build or deploy command, including framework-generated config. Edit its source rather than generated output.
- Establish the target account, Worker, environment, and resource before running commands that change them. For data operations, determine whether the target is local or remote.

## Retrieve What the Task Needs

Use the Cloudflare MCP `docs` tool if available, or fetch the relevant linked page directly. Follow links to the specific command or product involved; avoid loading the entire reference. If a page moves, rediscover it through the [Wrangler command index](https://developers.cloudflare.com/workers/wrangler/commands/) or Cloudflare docs search.

| Task | Source |
| --- | --- |
| Discover commands and flags, including resource management, deployments, rollback, and diagnostics | Project-local `wrangler --help` and `wrangler <command> --help`; [command reference](https://developers.cloudflare.com/workers/wrangler/commands/) |
| Edit config or add a binding | Installed `wrangler/config-schema.json` (usually under `node_modules`); [configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| Deploy a framework application | [Framework guides](https://developers.cloudflare.com/workers/framework-guides/); follow the guide for the project's existing framework and adapter |
| Migrate an application to Workers when requested | [Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/); [Vercel to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/vercel-to-workers/) |
| Configure staging or production | [Environments](https://developers.cloudflare.com/workers/wrangler/environments/) |
| Set secrets locally, in CI, or on a deployed Worker | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) |
| Generate binding and runtime types | [TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Run locally or choose a testing approach | [Local development](https://developers.cloudflare.com/workers/local-development/); [testing](https://developers.cloudflare.com/workers/testing/) |
| Diagnose authentication or select an account | [General commands](https://developers.cloudflare.com/workers/wrangler/commands/general/), including `whoami`; [authentication profiles](https://developers.cloudflare.com/workers/wrangler/profiles/) |
| Deploy an unauthenticated prototype | [Claim deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/) for eligibility, expiry, and claim URL handling; use a permanent account for production or CI |

Use installed help and schema to check whether documented features exist in the project's version. If a required feature needs an upgrade, make that dependency explicit. If retrieval is unavailable, state the gap and use available local evidence rather than inventing syntax.

## Apply the Change

- Prefer `wrangler.jsonc` for new config. Set a new project's [compatibility date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) to today; review runtime changes and test when advancing an existing project's date. Preserve existing project conventions and avoid incidental format migrations.
- Check environment inheritance before adding bindings or variables. Some fields must be specified separately for each environment; a working default config does not establish that staging is configured.
- With the Cloudflare Vite plugin, select the environment via `CLOUDFLARE_ENV` at dev or build time. Deploy the resulting build; setting an environment at deploy time does not retarget its flattened config. See [Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).
- Reconcile dashboard changes with the config before deploying: Wrangler can overwrite dashboard variables and routes. When binding existing resources, verify their identifiers; omitted identifiers can trigger [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).
- Distinguish local simulation from remote bindings during development. A locally running Worker can still access real resources; check the selected bindings before testing writes.
- Keep secret values out of command arguments, source code, and logs. Use the documented interactive input or protected file/stdin mechanism for the command. Local secret files must be ignored by version control and are not automatically uploaded as deployed secrets. For missing local secrets, check file precedence and any `secrets.required` declaration in the secrets docs.
- Treat `wrangler secret put` and `secret delete` as deployments: they create a version and deploy it immediately. Use the documented `wrangler versions secret` workflow when the change must be staged.
- Before a rollback, check [rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/): connected resources and their data are not rolled back with Worker code.

## Validate

After changing config or bindings in a TypeScript project, regenerate types with the project's `wrangler types` command rather than hand-editing generated declarations. Run the relevant existing typecheck or tests.

For deployment changes, use the project's build workflow and `wrangler deploy --dry-run` where supported, with the intended config and environment. A successful dry run checks the build and packaging; it does not prove remote resources or runtime behavior work. Use task-specific local or remote checks as appropriate to the requested work.

Report what changed, the target environment, checks performed, and any unresolved validation gaps. Link the documentation used when the result depends on current command or configuration behavior.
