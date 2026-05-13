# Kubernetes execution target — agent sizing

## Workload

- Image: `paperclipai/agent-runtime-claude:test-m3a` (claude-code from `@anthropic-ai/claude-code`)
- Prompt: `"Read README.md in /workspace and tell me the project name in one word."`
- Workspace: PVC seeded with a 2-file repo (README.md + .gitignore)
- Runs: 5 sequential, fresh PVC each run
- Cluster: kind v0.24.0 (Kubernetes v1.31.x), single node, on a CI runner

## Observations

| Metric    | Peak | Median | p95   |
|-----------|------|--------|-------|
| CPU (m)   | TBD  | TBD    | TBD   |
| Memory (Mi) | TBD | TBD  | TBD   |

(Numbers populated when the test is actually run. See "How we measured" below.)

## Recommended defaults

```yaml
resources:
  requests:
    cpu:    200m
    memory: 256Mi
  limits:
    cpu:    2
    memory: 1Gi
```

(M1 defaults retained until measurement justifies a bump — see "Decision".)

## Recommended ResourceQuota for a 50-agent tenant

```yaml
spec:
  hard:
    requests.cpu:    "10"
    requests.memory: "12Gi"
    limits.cpu:      "100"
    limits.memory:   "50Gi"
    count/jobs.batch: "50"
    count/persistentvolumeclaims: "50"
    count/secrets:   "200"
    count/configmaps: "100"
```

## Decision

Threshold for raising defaults:
- Memory: peak > 0.6 × current limit (614 Mi)
- CPU: peak > 0.5 × current limit (1000 m)

Decision: KEEP M1 defaults. Re-evaluate after first production runs surface real multi-turn workload data.

## Caveats

- This is a single-turn prompt. Multi-turn sessions (real agent loops) will use more memory due to accumulated context. Operators running multi-turn workloads should monitor actual usage and raise quotas accordingly.
- Numbers from the empirical-measurement test are taken on a CI runner; production hardware may show different baselines.

## How we measured

`packages/adapters/kubernetes-execution/test/integration/empirical-measurement-claude.test.ts` provisions kind + metrics-server, runs the workload 5 times under measurement, and writes the table above. Re-run with:

```bash
ANTHROPIC_API_KEY=... K8S_INTEGRATION=1 \
  pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/empirical-measurement-claude.test.ts
```

Cost: ~$0.05–0.20 per full run.
