# Paperclip Cloud Adapter — M3a Addendum: Make M2 Production-Usable

**Status**: Approved 2026-05-09. Implementation plan to follow.

**Parent spec**: [2026-05-08-paperclip-cloud-adapter-design.md](./2026-05-08-paperclip-cloud-adapter-design.md)
**M1 plan (shipped)**: [2026-05-08-paperclip-cloud-adapter-m1-plan.md](../plans/2026-05-08-paperclip-cloud-adapter-m1-plan.md)
**M2 plan (shipped)**: [2026-05-09-paperclip-cloud-adapter-m2-plan.md](../plans/2026-05-09-paperclip-cloud-adapter-m2-plan.md)

## Why this exists

M2 shipped the full driver path with two stubs that block real production use:

1. The end-to-end integration test uses a busybox+wget fake-agent because real `claude-code` requires an Anthropic key and a workspace with content. Until a real claude-code run succeeds, M2's "the agent works" claim has a gap.
2. `issueGitCredentials` always returns `{ ok: false, reason: "not_configured" }`. Until it returns real credentials, the workspace-init container can't clone private repos.

M2 also left two known TODOs:

3. Resource defaults are M1's hand-picked values (Risk #4 in the parent spec, partially resolved in M2 with measurement infrastructure but the busybox workload isn't representative).
4. Per-tenant Cilium policies are scaffolded but not wired through; every tenant gets the M1 default policy regardless of `cluster_tenant_policies` content.

M3a closes all four gaps in one tactical PR, ~1 week of work. Operator UI, GitHub App credential issuance, multi-adapter coverage, cross-replica rate-limiting, and image allow-lists are explicitly **not** in M3a — they're M3b.

---

## 1. Real claude-code end-to-end test

### What changes

- New integration test `test/integration/claude-code-real.test.ts` running real `claude-code` against real Anthropic, gated by `ANTHROPIC_API_KEY` env.
- The M2 fake-agent test (`claude-end-to-end.test.ts`) stays as a cheap smoke — it doesn't need Anthropic and runs in every CI build.
- The fake-agent Dockerfile + script (`_helpers/fake-agent.{Dockerfile,sh}`) are kept for the smoke test.

### Test shape

```ts
describe.skipIf(!process.env.K8S_INTEGRATION || !process.env.ANTHROPIC_API_KEY)("real claude-code on kind", () => {
  // beforeAll: spin kind, build agent-runtime-claude image, load into kind,
  //            seed workspace PVC with a small repo via initContainer git-clone,
  //            inject ANTHROPIC_API_KEY into the per-Job Secret.
  it("reads README.md via tool-use and surfaces the project name", async () => {
    const result = await driver.run({ ctx: { ...ctx, prompt: "Read README.md in /workspace and tell me the project name in one word." }, target });
    expect(result.exitCode).toBe(0);
    expect(capturedLogs.toLowerCase()).toContain("paperclip-claude-test");
  });
});
```

### Test seed repo

A new fixture at `test/integration/_fixtures/test-repo/` containing:
- `README.md` with `# paperclip-claude-test\n\nA small test repo for claude-code integration.\n`
- `.gitignore` (empty, just to look like a real repo)

The test creates the workspace by directly populating the PVC via a setup Pod that runs `git init && cp -r /fixtures/* . && git add . && git commit -m "init"`. This avoids needing the workspace-init container to call back to a server (workspace-init flows are exercised by M2's fake-agent test; this test focuses on the agent-side flow).

### Cost

~$0.01–0.05 per test run on Anthropic's API. The test is opt-in via `ANTHROPIC_API_KEY`; CI gates it on a designated key in repo secrets and skips on PRs from forks (no key access). Document in `docs/k8s-execution/CHANGELOG.md`.

### Output

- 1 new test file (~120 lines) + 1 fixture directory.
- No production code changes. The `agent-runtime-claude` image was already built in M2; this just exercises it.

---

## 2. Real `issueGitCredentials`

### Architecture

The existing `companySecrets` table + `SecretProvider` system already handles arbitrary per-company secrets resolved at runtime. M3a wires a specific use of it for git credentials.

### Schema change

Add to `cluster_tenant_policies`:

```ts
gitCredentialsSecretId: uuid("git_credentials_secret_id"),  // FK -> company_secrets.id, nullable
```

The secret holds a JSON-encoded `{ username: string, password: string }` (plaintext after decryption). Examples:

- GitHub PAT: `{ "username": "x-access-token", "password": "ghp_xxxxxxxxxxxx" }`
- GitLab deploy token: `{ "username": "deploy-paperclip", "password": "glpat-xxxxx" }`
- Bitbucket app password: `{ "username": "user@email", "password": "ATBBxxxxx" }`

The username/password format mirrors what the workspace-init container already injects into git via `GIT_USERNAME` / `GIT_PASSWORD` env vars. No protocol change.

### Service implementation

`server/src/services/git-credentials.ts`:

```ts
export interface IssueGitCredentialsInput {
  companyId: string;
  repoUrl: string;  // for logging/audit; we don't filter by URL in M3a
}

export async function issueGitCredentials(deps: { db: Db; secretService: SecretService; clusterTenantPolicies: ClusterTenantPoliciesService }, input: IssueGitCredentialsInput): Promise<IssueGitCredentialsResult> {
  const policy = await deps.clusterTenantPolicies.resolveForCompany(input.companyId);
  if (!policy?.gitCredentialsSecretId) return { ok: false, reason: "not_configured" };
  const resolved = await deps.secretService.resolve(policy.gitCredentialsSecretId);
  let parsed: { username?: unknown; password?: unknown };
  try { parsed = JSON.parse(resolved.plaintext); } catch { return { ok: false, reason: "internal_error" }; }
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return { ok: false, reason: "internal_error" };
  // 1h TTL is informational — the secret itself is long-lived; we surface
  // a stable expiry to keep workspace-init's contract identical to a future
  // GitHub App implementation.
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return { ok: true, username: parsed.username, password: parsed.password, expiresAt };
}
```

The route from M2 (`POST /api/workspace/git-credentials`) wires through this service instead of the M2 stub.

### CLI helper

```bash
paperclip cluster set-git-credentials --company <id> --secret-id <secretUuid>
```

Updates the tenant policy row. The secret itself is created via the existing `paperclip secrets create` flow (or whatever the current secret-management UX is — verify in implementation). M3a does not add a new secret-creation path.

### Limitations (acknowledged)

- One credential per company. Tenants with multiple repos pointing at different orgs/hosts must use a single PAT that covers all of them, OR pick the most-restrictive shared PAT.
- 1h TTL is fictional — the underlying secret is long-lived. The contract is stable for V2 (GitHub App) where TTL becomes real.
- No per-repo scoping. A compromised PAT exposes every repo it has access to. Operators who need scoping must wait for V2 or use deploy keys.

These are documented in `docs/k8s-execution/security-model.md` under a new "Git credentials in V1" section.

### Output

- Schema: 1 column on `cluster_tenant_policies` (combined with §4 in a single migration).
- 1 new service (`git-credentials.ts`, ~50 lines + tests).
- M2 route's stub replaced.
- 1 new CLI subcommand.
- ~3 new unit tests (configured/not-configured/malformed-secret).

---

## 3. Empirical resource numbers

### Workload

Re-run M2's `empirical-measurement.test.ts` infrastructure with:

- `agent-runtime-claude` image (real claude-code).
- Same prompt as item 1: `"Read README.md and tell me the project name in one word."`
- 5 sequential runs (one PVC, one Job per run, fresh Secret each).
- `metrics-server` polling every 5s (M2 already wires this).

This workload exercises the heaviest path of a typical agent run: prompt construction + tool use + Anthropic round-trip + response framing. It's still a single-turn run, which understates multi-turn workloads — but multi-turn varies wildly with task complexity, and a measured single-turn upper bound is enough to set sensible defaults.

### Defaults update

If measured peaks (across 5 runs) fit comfortably under M1's defaults (`requests: cpu=200m memory=256Mi`, `limits: cpu=2 memory=1Gi`), keep them. If peaks approach the limits, raise them with ~3× headroom on memory and ~2× on CPU.

The threshold for "approach" is `peakMemoryMi > 0.6 * limitMi` or `peakCpuM > 0.5 * limitM`. Decision recorded in the commit message.

### Doc update

Replace `docs/k8s-execution/sizing-fake-agent.md` with `sizing.md` carrying:

- Workload description (real claude-code, single-turn, README-summarize prompt)
- Sample size (5 runs)
- Peak / median / p95 of CPU and memory
- Recommended defaults (the values in the new `defaultTenantLimits`)
- Recommended `ResourceQuota` for a 50-agent tenant
- "How we measured this" section pointing at the test file
- Caveats: single-turn workload, not representative of long multi-turn tasks; operators should monitor actual usage and adjust quotas

Resolves Risk #4 fully.

### Output

- ~30 lines changed in `resource-quota.ts` (constant updates).
- ~1 file rewritten (`sizing.md`).
- M2's `empirical-measurement.test.ts` updated to use the real image; ~20 lines changed.

---

## 4. Per-tenant Cilium policies (DSL)

### Schema

Add two columns to `cluster_tenant_policies`:

```ts
ciliumDnsAllowlist:    text("cilium_dns_allowlist").array().notNull().default(sql`ARRAY[]::text[]`),
ciliumEgressCidrs:     text("cilium_egress_cidrs").array().notNull().default(sql`ARRAY[]::text[]`),
```

Empty arrays = no override; the M1 default policy (default-deny + RFC1918/CGNAT/IPv6-ULA except) applies unchanged.

### Semantics: additional CNP, intersection with M1

The M1 CiliumNetworkPolicy defines a permissive egress allowlist (default-deny + kube-dns + non-RFC1918). M3a does **not** mutate M1's CNP. Instead, when `ciliumDnsAllowlist` or `ciliumEgressCidrs` is non-empty, a **second** CiliumNetworkPolicy is applied alongside the M1 baseline.

Cilium evaluates multiple CNPs as an **intersection** for a given direction: traffic must be allowed by every selecting policy. So an M3a CNP that only permits `toFQDNs: [api.anthropic.com]` combines with the M1 CNP to produce an effective egress of "M1 baseline AND api.anthropic.com only" — i.e., locked down beyond the default.

When both arrays are empty, no second CNP is created and the M1 baseline applies unchanged.

### Builder

New function `buildTenantCiliumPolicy(input)` returns either `null` (both arrays empty) or a CNP object:

```ts
function buildTenantCiliumPolicy(input: { namespace: string; companySlug: string; dnsAllowlist: string[]; egressCidrs: string[] }): CiliumNetworkPolicy | null {
  if (input.dnsAllowlist.length === 0 && input.egressCidrs.length === 0) return null;
  const egress: CnpEgressRule[] = [
    // Always preserve kube-dns access — locking it out breaks every other rule
    { toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns" } }], toPorts: [{ ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } }] },
  ];
  if (input.dnsAllowlist.length > 0) {
    egress.push({ toFQDNs: input.dnsAllowlist.map((dns) => ({ matchName: dns })) });
  }
  if (input.egressCidrs.length > 0) {
    egress.push({ toCIDR: input.egressCidrs });
  }
  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: { name: `paperclip-tenant-${input.companySlug}-restrict`, namespace: input.namespace },
    spec: { endpointSelector: { matchLabels: { "paperclip.ai/managed-by": "paperclip" } }, egress },
  };
}
```

The "always preserve kube-dns" rule prevents the easy footgun where an operator sets `dnsAllowlist: ["api.anthropic.com"]` and accidentally blocks DNS resolution for `api.anthropic.com` itself.

### `ensureTenantNamespace` wiring

The orchestrator already takes a `tenantPolicy` parameter (M1). M3a calls `buildTenantCiliumPolicy(input)` after the M1 CNP is applied; if the result is non-null, it's applied as a second CNP. The existing M1 Cilium CRD client (added in M1 with `client.request`) handles the apply. Idempotency: the second CNP's name is deterministic per tenant, so repeat calls upsert.

### Test

- Unit test for the translator: empty arrays → identical to M1 output; populated → correct CNP rules.
- Integration test against kind+Cilium (M1 already has this harness): apply policy with `ciliumDnsAllowlist: ["api.anthropic.com"]`, verify a blocked egress (e.g., a curl to `github.com`) is actually blocked.

### Common operator recipes (documented)

`docs/k8s-execution/cilium-recipes.md`:

```
Recipe 1: Anthropic-only tenant
  ciliumDnsAllowlist: ["api.anthropic.com", "github.com"]
  ciliumEgressCidrs: []   # no extra CIDR allowlist beyond M1 default

Recipe 2: Self-hosted git tenant
  ciliumDnsAllowlist: ["api.anthropic.com"]
  ciliumEgressCidrs: ["10.42.0.0/16"]   # allow internal git host
```

### Output

- Schema: 2 columns on `cluster_tenant_policies` (combined with §2 in a single migration).
- New `buildTenantCiliumPolicy` function in `cilium-network-policy.ts` (~40 lines).
- 2 new tests (1 unit + 1 integration on kind+Cilium).
- 1 new doc file (`cilium-recipes.md`).

---

## Out of scope for M3a

- Operator UI for cluster connections, namespace bindings, tenant policies — M3b.
- GitHub App for git credentials — V2 / on-demand.
- Cross-replica rate limit store (Redis) — M3b.
- Operator-controlled image allow-lists per cluster — M3b.
- Multi-adapter k8s coverage (codex, gemini, opencode, acpx, pi, hermes) — M3b/M4.
- Live run dashboard (log tail, event timeline) — M3b.

## Risks / open questions

| # | Risk | Disposition |
|---|------|---|
| A | `ANTHROPIC_API_KEY` exposure in CI | Use repo-secrets, never run real-Anthropic test on PRs from forks. Document. |
| B | Single PAT covers multiple repos with too-broad scope | Acknowledged limitation; documented in security-model.md. V2 GitHub App resolves it. |
| C | Empirical workload (single-turn README summarize) underestimates real usage | Defaults sized with 3× memory / 2× CPU headroom; sizing.md documents the limitation; operators advised to monitor actual usage. |
| D | Tenant accidentally locks itself out by setting `ciliumDnsAllowlist` without including its git host | Documentation calls out the requirement; integration test asserts the behavior. No automated guardrail in M3a. |

## Output summary

- **One PR**, ~12-15 commits, targeting `master` after both M1 (#5556) and M2 (#5558) land.
- **No new package** — all changes are in existing packages (server, kubernetes-execution, db).
- **One schema migration** (3 new columns: `cluster_tenant_policies.git_credentials_secret_id`, `cluster_tenant_policies.cilium_dns_allowlist`, `cluster_tenant_policies.cilium_egress_cidrs`).
- **No new spec doc** beyond this addendum.

## Estimated work

| Item | Days |
|------|------|
| 1. Real claude-code test | 1.5 |
| 2. Real `issueGitCredentials` | 1.5 |
| 3. Empirical numbers | 1.0 |
| 4. Per-tenant Cilium DSL | 2.0 |
| Cross-cutting (CHANGELOG, docs polish) | 0.5 |
| **Total** | **6.5** |

Roughly one focused week.
