# Artifacts API Reference

Use Artifacts through the **Workers binding**, the **REST control plane**, and **Git-compatible remotes**.

**Prefer retrieval** for exact request and response details. Verify current behavior at `https://developers.cloudflare.com/artifacts/` before relying on specific auth flows, route details, or generated binding types.

## Workers Binding

Artifacts exposes a Worker binding on `env.ARTIFACTS`.

### Namespace Methods

| Method | Use For |
|--------|---------|
| `create(name, opts?)` | Create a repo and receive its initial remote and token |
| `get(name)` | Resolve a repo handle for repo-scoped operations |
| `list(opts?)` | List repos in a namespace |
| `delete(name)` | Delete a repo |

```typescript
const created = await env.ARTIFACTS.create("starter-repo", {
  description: "Repository for automation experiments",
  setDefaultBranch: "main"
});
const repo = await env.ARTIFACTS.get("starter-repo");
const page = await env.ARTIFACTS.list({ limit: 10 });
```

Use the REST API when you need to import a repo from another HTTPS remote.

### Repo Handle Methods

Use a repo handle returned by `get()` or `create()`.

| Method | Use For |
|--------|---------|
| `info()` | Read repo metadata, including the remote URL |
| `createToken(scope?, ttl?)` | Mint a repo-scoped read or write token |
| `listTokens()` | Inspect active tokens |
| `validateToken(token)` | Check whether a token is still valid |
| `revokeToken(tokenOrId)` | Revoke a token by ID or value |
| `fork(name, opts?)` | Fork one repo into another |

```typescript
const repo = await env.ARTIFACTS.get("starter-repo");
if (!repo) throw new Error("Repo not found");

const info = await repo.info();
const token = await repo.createToken("read", 3600);
const forked = await repo.fork("starter-repo-copy", {
  defaultBranchOnly: true
});
```

### Binding Notes

- Current docs describe the runtime binding surface as `create`, `get`, `list`, `delete`, and repo-handle methods like `info`, `createToken`, and `fork`.
- Use `npx wrangler types` in the target project and treat the generated `worker-configuration.d.ts` as the source of truth for that environment.
- If generated types appear to expose `import()` or a different `get()` shape, verify the live docs before depending on those methods.

Verify current runtime behavior in the live docs before depending on methods that are not shown in the Workers binding reference.

## REST API

Artifacts currently documents a namespace-scoped control plane:

```txt
https://artifacts.cloudflare.net/v1/api/namespaces/$ARTIFACTS_NAMESPACE
```

Some deployments also expose an `/edge/v1/api/...` base path. Verify the correct base URL for your environment in the live docs.

Requests to the standard `/v1/api/...` routes use a **gateway JWT** with Bearer authentication.

Returned repo tokens authenticate **Git operations** against the repo `remote`. They do not authenticate REST control-plane requests.

Current docs show the standard Cloudflare v4 response envelope around REST results.

### Repo Routes

| Route | Use For |
|-------|---------|
| `POST /repos` | Create a repo |
| `GET /repos` | List repos |
| `GET /repos/:name` | Read repo metadata and remote |
| `DELETE /repos/:name` | Delete a repo |
| `POST /repos/:name/fork` | Fork a repo |
| `POST /repos/:name/import` | Import a public HTTPS remote |

```bash
curl --request POST "$ARTIFACTS_BASE_URL/repos" \
  --header "Authorization: Bearer $ARTIFACTS_JWT" \
  --header "Content-Type: application/json" \
  --data '{"name":"starter-repo"}'
```

Important current details from the docs draft:
- `POST /repos/:name/import` accepts a full HTTPS remote URL such as GitHub or GitLab.
- Import supports options such as `branch`, `depth`, and `read_only`.
- Repo metadata includes fields such as description, default branch, timestamps, and the Git `remote`.

### Token Routes

| Route | Use For |
|-------|---------|
| `GET /repos/:name/tokens` | List repo tokens |
| `POST /tokens` | Create a token for a repo |
| `DELETE /tokens/:id` | Revoke a token by ID |

Current docs show list-token filtering and pagination by token state. Retrieve the exact query shape from the live docs when you need token audit or cleanup workflows.

Use **read** tokens for clone, fetch, pull, and indexing workflows. Use **write** tokens only when a workflow must push or otherwise mutate a repo.

## Git-Compatible Access

Artifacts returns repo `remote` URLs that work with standard git-over-HTTPS tooling.

Recommended current auth pattern for local workflows:

```bash
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone "$ARTIFACTS_REMOTE" artifacts-clone
```

Use a self-contained Basic-auth remote only for short-lived commands that need credentials embedded in the URL.

`read` tokens support `clone`, `fetch`, and `pull`. `git push` requires a `write` token.

For large repos where startup time matters more than a full clone, Artifacts also documents **ArtifactFS**. Retrieve current details from `https://developers.cloudflare.com/artifacts/` when you need mount-style access.
