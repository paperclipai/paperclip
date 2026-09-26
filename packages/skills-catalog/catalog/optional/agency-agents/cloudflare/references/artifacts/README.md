# Cloudflare Artifacts

Store versioned file trees behind a repo-style interface that works from Workers, the REST API, and Git-compatible tooling.

## Overview

Use **Artifacts** when the thing you need to store is a versioned filesystem tree rather than a single object, key, or SQL row.

Typical Artifacts use cases:
- Git-style repositories
- Per-agent, per-session, or per-task repos
- Build outputs and deployment bundles
- Checkpoints and generated assets
- Shared file trees passed between developer tools and Workers

Artifacts is a good fit when the same content needs to be addressable from **Workers**, the **REST API**, and **Git-compatible clients**.

Artifacts is especially useful for agent and automation workflows where each unit of work should have its own isolated repo and token.

**Prefer retrieval over memory** for current availability, authentication details, route shapes, limits, and pricing. Start at `https://developers.cloudflare.com/artifacts/`.

## When to Use Artifacts

| Need | Use | Why |
|------|-----|-----|
| Versioned file trees such as repos, build outputs, checkpoints, or generated assets | Artifacts | Artifacts stores and shares **versioned filesystem content** |
| A git-compatible workflow with `clone`, `fetch`, `pull`, or `push` | Artifacts | Artifacts exposes **git-over-HTTPS remotes** and repo-scoped tokens |
| The same artifact accessible from Workers, HTTP APIs, and developer tooling | Artifacts | Artifacts is available through a **Workers binding**, **REST API**, and **git-compatible interface** |
| Large files by object key, app config by key, or relational app data | R2, KV, or D1 | Use storage products directly when you need **objects, key-value entries, or SQL rows**, not versioned file trees |

## Recommended Workflow

- Create one repo per agent, session, user workspace, or task when work should stay isolated.
- Fork from a stable baseline when many repos need the same starter files or prompts.
- Use branches only when collaborators share the same lifecycle and need to work in one repo.
- Use namespaces to separate environments, teams, or high-rate workloads.

## Quick Start

**From a Worker:**

```typescript
interface Env {
  ARTIFACTS: Artifacts;
}

const created = await env.ARTIFACTS.create("starter-repo");
// created.remote -> git remote URL
// created.token -> initial repo token
```

**From the REST API:**

Use the namespace-scoped Artifacts base URL plus a gateway JWT. For imports from existing HTTPS remotes, use the REST API rather than the Workers binding.

## Reading Order

| Task | Read |
|------|------|
| Decide whether Artifacts is the right product | README only |
| Create or manage repos from a Worker | README → configuration.md → api.md |
| Integrate Artifacts from an external system | README → api.md |
| Set up agent or sandbox workflows | README → configuration.md |
| Verify exact auth, routes, limits, or pricing | Live docs first: `https://developers.cloudflare.com/artifacts/` |

## In This Reference

- **[api.md](api.md)** - Workers binding methods, REST routes, token and repo operations
- **[configuration.md](configuration.md)** - Wrangler binding shape, Worker typing, REST configuration guidance

## See Also

- [Cloudflare Artifacts Docs](https://developers.cloudflare.com/artifacts/)
- [Artifacts Git Protocol Docs](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [ArtifactFS Docs](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Durable Objects Docs](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
