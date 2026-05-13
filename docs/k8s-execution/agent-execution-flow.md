---
title: Kubernetes Execution — Agent Execution Flow
summary: End-to-end walkthrough of what happens when an operator runs an agent against a Kubernetes-bound tenant, from CLI invocation to assistant text streaming back
---

This document traces the full path of one agent run on a Kubernetes execution target. Read it after [quickstart.md](./quickstart.md) — the cluster connection and tenant namespace must already exist before any of the steps below have meaning.

The artifacts referenced are real and are produced by code that ships in M2. Pointers to source files are absolute paths inside this repo.

## Sequence

The numbered steps below trace one `paperclip agent run` from operator keystroke to assistant text in the operator's terminal.

1. **CLI invocation.** The operator runs `paperclipai agent run --agent <id> --prompt "..."`. The CLI forwards the request to the Paperclip server through its normal authenticated control-plane API.

2. **Server resolves the execution target.** The server looks up the agent's `executionTargetId`. If it points at a `kubernetes:<label>` target, the request is routed to the `KubernetesExecutionDriver` (`packages/adapters/kubernetes-execution/src/driver.ts`). For a `local` target, nothing in this document applies — the agent runs as a child process on the server host.

3. **Driver mints a bootstrap token.** Before any pod is created, `driver.run()` calls the configured `BootstrapTokenMinter` (server-side wiring in `server/src/services/bootstrap-tokens.ts`) to mint a single-use token bound to `(agentId, companyId, runId)`. This token never leaves the server's process memory until it is sealed into the per-Job Secret in the next step.

4. **Driver materializes per-Job objects.** Inside the tenant namespace `paperclip-<companySlug>` the driver creates, in order:
   - A `PersistentVolumeClaim` (`packages/adapters/kubernetes-execution/src/orchestrator/pvc.ts`) for the agent's `/workspace` mount.
   - A `Secret` of type `Opaque` (`.../orchestrator/secret.ts`) carrying `BOOTSTRAP_TOKEN`, redacted adapter env, and any per-tenant credentials. The Secret is created first; the Job is created next; finally the driver patches the Secret's `ownerReferences` to point at the Job so the Secret is garbage-collected when the Job's TTL expires.
   - A `Job` (`.../orchestrator/job.ts`) with two containers:
     - **Init container `workspace-init`** runs `/usr/local/bin/paperclip-workspace-init` from the `agent-runtime-base` image. It executes the workspace strategy from `@paperclipai/workspace-strategy` (e.g., clones a git repo into `/workspace`).
     - **Main container `agent`** runs `/usr/bin/tini -- /usr/local/bin/paperclip-agent-shim` from the adapter-specific image (e.g., `agent-runtime-claude`).

   Every object carries the labels `paperclip.ai/managed-by=paperclip`, `paperclip.ai/company-id=<uuid>`, `paperclip.ai/agent-id=<uuid>`, and `paperclip.ai/run-id=<runUlid>`.

5. **Init container clones the workspace.** `workspace-init` reads `PAPERCLIP_WORKSPACE_STRATEGY` (a JSON blob) and executes it. For a `git_clone` strategy it calls `POST /api/workspace/git-credentials` against the Paperclip server, exchanging the bootstrap token for short-lived git credentials, then clones into `/workspace`. On success, the init container exits 0.

6. **Main container starts the shim.** Kubernetes brings up the `agent` container after the init container succeeds. `paperclip-agent-shim` (Go binary, `tools/agent-shim/`) reads `/run/paperclip/runtime-command.json`, calls `POST /api/agent-auth/exchange` to swap the bootstrap token for a run-scoped JWT, then `syscall.Exec`s the adapter CLI (e.g. `claude-code` for `agent-runtime-claude`).

7. **Adapter runs.** The adapter (e.g. claude-code) reads the prompt from its arguments / stdin, calls Anthropic's API, and streams its assistant text to stdout. While running it may post progress events through `POST /api/runs/:runId/events` using the run JWT.

8. **Server tails pod logs.** While the Job is running, `driver.run()` opens a `pods/log` follow stream (`.../orchestrator/log-stream.ts`) for the `agent` container and forwards bytes to the adapter's normal log/event sink. The CLI receives those bytes through the same control-plane channel used by local-target runs and prints them to the operator's terminal.

9. **Job terminates and garbage-collects.** When the adapter exits, the Job moves to `Succeeded` (or `Failed`). The driver maps the terminal state through `failure-mapping.ts`, returns the result, and Kubernetes garbage-collects the Job, Pod, and Secret per the Job's `ttlSecondsAfterFinished`. The PVC stays unless the tenant policy says otherwise (V2 will manage PVC reuse).

## Inspecting a live run with kubectl

Set a shell variable to the agent's namespace and run ID once:

```bash
NS=paperclip-<companySlug>
RUN=<runUlid>
```

Both values appear in the CLI output and on the server's run record.

```bash
# Everything for this one run
kubectl -n "$NS" get pods,jobs,pvcs,secrets,events \
  -l "paperclip.ai/run-id=$RUN"
```

Sample output for a healthy run mid-flight:

```
NAME                      READY   STATUS    RESTARTS   AGE
pod/run-<runUlid>-h2x7q   1/1     Running   0          18s

NAME                  COMPLETIONS   DURATION   AGE
job.batch/run-<runUlid>   0/1       18s        18s

NAME                                    STATUS   VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
persistentvolumeclaim/run-<runUlid>     Bound    pvc-...  10Gi       RWO            standard       19s

NAME                              TYPE     DATA   AGE
secret/run-<runUlid>              Opaque   3      19s

LAST SEEN   TYPE     REASON       OBJECT                       MESSAGE
19s         Normal   Scheduled    pod/run-<runUlid>-h2x7q      Successfully assigned ...
18s         Normal   Pulled       pod/run-<runUlid>-h2x7q      Container image "agent-runtime-base" already present
18s         Normal   Started      pod/run-<runUlid>-h2x7q      Started container workspace-init
12s         Normal   Started      pod/run-<runUlid>-h2x7q      Started container agent
```

Tail the agent container's logs directly (the same bytes the server forwards to the CLI):

```bash
kubectl -n "$NS" logs -f -l "paperclip.ai/run-id=$RUN" -c agent
```

Inspect the init container's output if you suspect a workspace clone failure:

```bash
kubectl -n "$NS" logs -l "paperclip.ai/run-id=$RUN" -c workspace-init
```

Describe the Pod to see scheduling, image-pull, and resource-quota events:

```bash
kubectl -n "$NS" describe pod -l "paperclip.ai/run-id=$RUN"
```

## Run ID is the correlation key

Every persisted resource (Job, Pod, PVC, Secret) carries `paperclip.ai/run-id=<runUlid>`. Server-side log lines, OpenTelemetry spans, and DB rows use the same value. When a run misbehaves, list everything by that label first:

```bash
kubectl get all,pvc,secrets -A -l "paperclip.ai/run-id=$RUN"
```

## Failures and what to look at

If the `kubectl` walkthrough above shows symptoms instead of healthy output, jump to [troubleshooting.md](./troubleshooting.md) which maps each common failure mode (Pending pods, ImagePullBackOff, init failures, bootstrap rejection, OOM, timeouts) to the exact recipe that diagnoses it.

## Related

- [Quickstart](./quickstart.md) — set up the cluster connection and provision a tenant
- [Security model](./security-model.md) — isolation primitives applied to every run
- [Troubleshooting](./troubleshooting.md) — operator failure-mode playbook
- [Multi-tenant onboarding](./multi-tenant-onboarding.md) — playbook for provisioning multiple companies
