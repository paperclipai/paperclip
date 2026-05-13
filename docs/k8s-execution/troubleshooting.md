---
title: Kubernetes Execution — Troubleshooting
summary: Operator-facing playbook for the common failure modes that show up when running agents on Kubernetes-bound tenants
---

This document maps each failure mode to a concrete `kubectl` recipe that diagnoses it. Set the namespace and run ID once and reuse them:

```bash
NS=paperclip-<companySlug>
RUN=<runUlid>
```

For the full happy-path walkthrough see [agent-execution-flow.md](./agent-execution-flow.md).

## Pod stuck in `Pending`

Symptom: the run never starts; `kubectl get pods` shows `Pending` for many seconds.

The two usual causes are `ResourceQuota` rejection (the namespace is at its CPU/memory ceiling) and PodSecurity admission (the spec is not Restricted-compliant).

```bash
kubectl -n "$NS" describe pod -l "paperclip.ai/run-id=$RUN"
```

Check the `Events:` section at the bottom. Specific patterns:

- `exceeded quota: paperclip-tenant-quota, requested: ..., used: ..., limited: ...` — the tenant quota is full. List currently active runs in the namespace:

  ```bash
  kubectl -n "$NS" get jobs -l paperclip.ai/managed-by=paperclip
  ```

  Either wait for inflight runs to drain or raise the per-tenant quota via the `cluster_tenant_policies` row.

- `violates PodSecurity "restricted:..."` — the runtime image or pod spec violates the Restricted profile. The driver always emits Restricted-compliant specs, so this points to a customized agent image. Re-pull `agent-runtime-base` / `agent-runtime-claude` from `ghcr.io/paperclipai/` to confirm.

## ImagePullBackOff

Symptom: `kubectl get pods` shows `ImagePullBackOff` or `ErrImagePull`.

Cause: the agent runtime image cannot be pulled from the cluster. The two paths to check:

1. The namespace has the `paperclip-image-pull` `Secret`:

   ```bash
   kubectl -n "$NS" get secret | grep paperclip-image-pull
   ```

   If absent, re-run `paperclipai cluster ensure-tenant <clusterId> <companyId>` after confirming the cluster connection has `imagePullDockerConfigJson` resolved.

2. The Pod actually references that Secret as an `imagePullSecret`:

   ```bash
   kubectl -n "$NS" get pod -l "paperclip.ai/run-id=$RUN" \
     -o jsonpath='{.items[*].spec.imagePullSecrets}'
   ```

   Expected: `[{"name":"paperclip-image-pull"}]`. If empty, the cluster connection lacks an image registry binding — see [quickstart.md](./quickstart.md).

For private registries that require cosign verification, see [security-model.md](./security-model.md).

## Job failed but logs are empty

Symptom: `kubectl get job` shows `Failed`; `kubectl logs <pod> -c agent` returns nothing.

Cause: the `workspace-init` init container failed before the `agent` container ever started. Init logs are a different stream:

```bash
kubectl -n "$NS" logs -l "paperclip.ai/run-id=$RUN" -c workspace-init
```

Common init failures:

- `git clone failed: authentication required` — the workspace strategy referenced a private repo but the bootstrap-exchange flow returned no usable git credentials. Confirm the agent's company has a configured git provider and that `POST /api/workspace/git-credentials` is reachable from the cluster.
- `unsupported workspace strategy kind: ...` — the strategy JSON was not understood by `@paperclipai/workspace-strategy`. Look at `PAPERCLIP_WORKSPACE_STRATEGY` on the init container:

  ```bash
  kubectl -n "$NS" get pod -l "paperclip.ai/run-id=$RUN" \
    -o jsonpath='{.items[*].spec.initContainers[?(@.name=="workspace-init")].env}'
  ```

## Bootstrap exchange returns 401

Symptom: agent logs include `bootstrap exchange failed: 401 invalid_token` shortly after the agent container starts.

Two likely causes:

1. **`PAPERCLIP_PUBLIC_URL` misconfigured on the Job.** Confirm the value the pod was started with:

   ```bash
   kubectl -n "$NS" get pod -l "paperclip.ai/run-id=$RUN" \
     -o yaml | grep -A1 PAPERCLIP_PUBLIC_URL
   ```

   The URL must be reachable from inside the cluster. For an in-cluster Paperclip server use the in-cluster Service DNS; for cross-cluster use the externally reachable HTTPS URL.

2. **Clock skew.** Bootstrap tokens are short-lived. If the pod's clock is more than a few minutes off the server's clock the JWT expiry check fails. This is rare on managed clusters but appears on lab clusters using laptop nodes that suspend.

3. **Server is missing `PAPERCLIP_RUN_JWT_SECRET`.** When the env var is absent, the callback routes are skipped during app boot (see `server/src/app.ts`). Confirm the server log line `mounted k8s callback routes` was emitted at startup. If not, set `PAPERCLIP_RUN_JWT_SECRET` on the server and restart.

## Run was killed mid-flight

Symptom: agent log ends abruptly with no exit message; `kubectl get pod` shows `Terminating` or the pod is gone.

Inspect the Job's terminal state and recent events:

```bash
kubectl -n "$NS" describe job -l "paperclip.ai/run-id=$RUN"
kubectl -n "$NS" get events --sort-by=.lastTimestamp | grep "$RUN"
```

Look for:

- `BackoffLimitExceeded` — the agent crashed and Kubernetes gave up retrying.
- `DeadlineExceeded` — `activeDeadlineSeconds` was hit. Look at the agent's runtime command to see whether the job was expected to take longer than the configured budget.
- `OOMKilled` (in pod events) — the main container exceeded its memory limit. Adjust the per-tenant resource defaults in `cluster_tenant_policies` or pick a less memory-hungry adapter.

## Correlate every resource for one run

Every persisted resource carries `paperclip.ai/run-id=<runUlid>`:

```bash
kubectl get all,pvc,secrets -n "$NS" -l "paperclip.ai/run-id=$RUN"
```

Use this when forensics involves more than one object kind.

## Related

- [Agent execution flow](./agent-execution-flow.md) — the happy path this document mirrors
- [Security model](./security-model.md) — what each isolation control is supposed to enforce
- [Quickstart](./quickstart.md) — first-time setup and `cluster doctor`
