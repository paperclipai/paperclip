import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { spinUpKind, type KindCluster } from "./_harness.js";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";
import {
  buildAgentWorkspacePvc,
  applyAgentWorkspacePvc,
} from "../../src/orchestrator/pvc.js";
import {
  buildEphemeralSecret,
  applyEphemeralSecret,
  patchEphemeralSecretOwnerReference,
} from "../../src/orchestrator/secret.js";
import { mapTerminalState } from "../../src/orchestrator/failure-mapping.js";
import { buildBusyboxTestJob } from "./_helpers/busybox-job.js";
import type { KubernetesApiClient } from "../../src/types.js";

/**
 * M2 Task 27: integration tests for failure modes against a real kind cluster.
 *
 * Each case proves that `mapTerminalState` produces the right errorCode when
 * fed real Job + Pod objects pulled from the cluster after a controlled
 * failure. The success path is covered by `job-lifecycle.test.ts`.
 *
 * Cases:
 *   1. ImagePullBackOff   → image_pull_failed
 *   2. OOMKilled          → oom_killed (exitCode 137)         [may skip on Apple Silicon]
 *   3. DeadlineExceeded   → timeout
 *   4. Init container 2   → workspace_init_failed
 *
 * All four cases share one kind cluster (spun up in beforeAll) but each runs
 * in its own dedicated namespace with its own PVC/Secret/Job to keep state
 * isolated.
 */

const COMPANY_ID = "33333333-3333-3333-3333-333333333333";

interface FailureCaseFixture {
  namespace: string;
  pvcName: string;
  secretName: string;
  jobName: string;
}

async function setupFailureCaseFixture(
  client: KubernetesApiClient,
  connection: ResolvedClusterConnection,
  companySlug: string,
  agentSlug: string,
  runUlid: string,
): Promise<FailureCaseFixture> {
  const ensureResult = await ensureTenantNamespace(client, {
    connection,
    company: { id: COMPANY_ID, slug: companySlug },
    tenantPolicy: null,
    driverServiceAccount: { name: "default", namespace: "default" },
    controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
    adapterAllowFqdns: [],
    imagePullDockerConfigJson: null,
  });
  const namespace = ensureResult.namespace;

  const pvc = buildAgentWorkspacePvc({
    namespace,
    agentId: "44444444-4444-4444-4444-444444444444",
    agentSlug,
    companyId: COMPANY_ID,
    companySlug,
    storageClass: "standard",
    sizeGi: 1,
    strategyKey: "none",
  });
  await applyAgentWorkspacePvc(client, pvc);

  const secret = buildEphemeralSecret({
    namespace,
    agentSlug,
    runUlid,
    runId: `test-run-${runUlid}`,
    companyId: COMPANY_ID,
    companySlug,
    data: { MY_KEY: "value" },
    ownerJob: {
      name: "placeholder",
      uid: "00000000-0000-0000-0000-000000000000",
    },
  });
  const secretName = secret.metadata!.name!;
  secret.metadata!.ownerReferences = [];
  await applyEphemeralSecret(client, secret);

  const jobName = `agent-${agentSlug}-run-${runUlid}`;
  return { namespace, pvcName: pvc.metadata!.name!, secretName, jobName };
}

async function findPod(
  client: KubernetesApiClient,
  namespace: string,
  jobName: string,
): Promise<V1Pod | undefined> {
  const list = await client.core.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `job-name=${jobName}`,
  );
  return list.body.items[0];
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  deadlineMs: number,
  intervalMs = 1000,
): Promise<T | undefined> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "failure-mode mapping on kind",
  () => {
    let kind: KindCluster;
    let client: KubernetesApiClient;
    let connection: ResolvedClusterConnection;

    beforeAll(() => {
      kind = spinUpKind();
      connection = {
        id: "c-1",
        label: "kind",
        kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: {
          cilium: false,
          storageClass: "standard",
          architectures: ["amd64"],
        },
      };
      client = createKubernetesApiClient(connection);
    }, 240_000);

    afterAll(() => {
      kind?.cleanup();
    });

    it(
      "ImagePullBackOff -> image_pull_failed",
      async () => {
        const fx = await setupFailureCaseFixture(
          client,
          connection,
          "fail-imgpull",
          "imgpull-agent",
          "01testimagepullbackoff0001",
        );
        const jobSpec = buildBusyboxTestJob({
          namespace: fx.namespace,
          jobName: fx.jobName,
          pvcName: fx.pvcName,
          envSecretName: fx.secretName,
          // Bogus image — the registry exists but the repo/tag does not, so
          // the kubelet will hit ErrImagePull then ImagePullBackOff.
          image: "ghcr.io/paperclipai/does-not-exist:never",
          activeDeadlineSeconds: 300,
        });
        const created = await client.batch.createNamespacedJob(fx.namespace, jobSpec);
        await patchEphemeralSecretOwnerReference(
          client,
          fx.namespace,
          fx.secretName,
          { name: fx.jobName, uid: created.body.metadata!.uid! },
        );

        // Poll until the agent container reports either ErrImagePull or
        // ImagePullBackOff. mapTerminalState handles both so we don't need to
        // wait for the slower ImagePullBackOff state to latch.
        const pod = await pollUntil<V1Pod>(async () => {
          const p = await findPod(client, fx.namespace, fx.jobName);
          const c = p?.status?.containerStatuses?.find((s) => s.name === "agent");
          const reason = c?.state?.waiting?.reason;
          if (reason === "ImagePullBackOff" || reason === "ErrImagePull") return p;
          return undefined;
        }, 90_000);
        expect(pod, "expected pod to enter ErrImagePull/ImagePullBackOff").toBeTruthy();

        // Refresh the Job for the mapping input. The Job won't be terminal
        // yet (kubelet keeps retrying pulls), but mapTerminalState detects
        // ImagePullBackOff on the pod's container status regardless.
        const j = await client.batch.readNamespacedJob(fx.jobName, fx.namespace);
        const result = mapTerminalState({ job: j.body, pod });
        expect(result.errorCode).toBe("image_pull_failed");
        expect(result.errorFamily).toBe("transient_upstream");
        expect(result.exitCode).toBeNull();
        expect(result.timedOut).toBe(false);
      },
      180_000,
    );

    // OOM signaling on kind on Apple Silicon (Docker Desktop, cgroup v2 inside
    // a Linux VM) can be flaky: the container runtime sometimes reports
    // exitCode 137 with reason "Error" instead of "OOMKilled", and
    // occasionally surfaces a plain non-zero exit. The mapping function
    // accepts either reason="OOMKilled" OR exitCode===137, but if neither
    // shows up we want to know rather than silently green. Verify and document
    // any platform skew in the report.
    it(
      "OOMKilled -> oom_killed (exitCode 137)",
      async () => {
        const fx = await setupFailureCaseFixture(
          client,
          connection,
          "fail-oom",
          "oom-agent",
          "01testoomkilled000000000001",
        );
        const jobSpec = buildBusyboxTestJob({
          namespace: fx.namespace,
          jobName: fx.jobName,
          pvcName: fx.pvcName,
          envSecretName: fx.secretName,
          // Allocate ~200 MiB of anonymous memory inside the busybox shell's
          // own heap by reading 200 MB of zeros into a command-substitution
          // string. POSIX `$(…)` semantics require the shell to buffer the
          // child process's stdout completely before substituting it into the
          // variable assignment, which forces the kernel to back those bytes
          // with physical pages on the shell's anonymous heap. With a 32 MiB
          // memory limit this overshoots the cgroup and the OOM-killer fires,
          // surfacing as exitCode=137 + reason=OOMKilled in containerStatuses.
          // Verified manually with `docker run --rm -m 32m busybox:1.36 sh -c
          // ...` reproducing exit 137.
          //
          // No external image dependency — stays on busybox:1.36, which is
          // multi-arch (linux/amd64, linux/arm64) so this works identically
          // on Apple Silicon and CI x86_64 runners.
          agentScript:
            "echo allocating; a=$(head -c 200000000 /dev/zero | tr '\\0' 'a'); echo done; exit 0",
          memoryLimit: "32Mi",
          activeDeadlineSeconds: 60,
        });
        const created = await client.batch.createNamespacedJob(fx.namespace, jobSpec);
        await patchEphemeralSecretOwnerReference(
          client,
          fx.namespace,
          fx.secretName,
          { name: fx.jobName, uid: created.body.metadata!.uid! },
        );

        // Poll until the agent container terminates.
        const pod = await pollUntil<V1Pod>(async () => {
          const p = await findPod(client, fx.namespace, fx.jobName);
          const c = p?.status?.containerStatuses?.find((s) => s.name === "agent");
          if (c?.state?.terminated) return p;
          return undefined;
        }, 60_000);
        expect(pod, "expected agent container to terminate").toBeTruthy();

        const j = await client.batch.readNamespacedJob(fx.jobName, fx.namespace);
        const result = mapTerminalState({ job: j.body, pod });

        // Diagnostics: log the raw container terminated state so a
        // platform-specific surprise is visible in CI output.
        const term = pod!.status?.containerStatuses?.find((c) => c.name === "agent")
          ?.state?.terminated;
        if (result.errorCode !== "oom_killed") {
          // eslint-disable-next-line no-console
          console.warn(
            "[failure-modes/oom] expected oom_killed but got",
            { errorCode: result.errorCode, exitCode: result.exitCode, terminated: term },
          );
        }

        // mapTerminalState accepts either reason==="OOMKilled" or
        // exitCode===137 as the OOM signal. If kind on this host surfaces
        // neither, the mapping legitimately reports agent_exit_nonzero and the
        // assertion will catch it — at which point the test should be
        // re-marked it.skip with a documented platform reason.
        expect(result.errorCode).toBe("oom_killed");
        expect(result.exitCode).toBe(137);
        expect(result.signal).toBe("SIGKILL");
        expect(result.timedOut).toBe(false);
      },
      120_000,
    );

    it(
      "DeadlineExceeded -> timeout",
      async () => {
        const fx = await setupFailureCaseFixture(
          client,
          connection,
          "fail-deadline",
          "deadline-agent",
          "01testdeadlineexceeded00001",
        );
        const jobSpec = buildBusyboxTestJob({
          namespace: fx.namespace,
          jobName: fx.jobName,
          pvcName: fx.pvcName,
          envSecretName: fx.secretName,
          agentScript: "echo sleeping; sleep 600; echo done",
          activeDeadlineSeconds: 5,
        });
        const created = await client.batch.createNamespacedJob(fx.namespace, jobSpec);
        await patchEphemeralSecretOwnerReference(
          client,
          fx.namespace,
          fx.secretName,
          { name: fx.jobName, uid: created.body.metadata!.uid! },
        );

        // Poll until the Job has the Failed/DeadlineExceeded condition.
        const terminalJob = await pollUntil<V1Job>(async () => {
          const j = await client.batch.readNamespacedJob(fx.jobName, fx.namespace);
          const failedCond = j.body.status?.conditions?.find(
            (c) => c.type === "Failed" && c.reason === "DeadlineExceeded",
          );
          if (failedCond) return j.body;
          return undefined;
        }, 60_000);
        expect(terminalJob, "expected Job to fail with DeadlineExceeded").toBeTruthy();

        const pod = await findPod(client, fx.namespace, fx.jobName);
        const result = mapTerminalState({ job: terminalJob!, pod });
        expect(result.errorCode).toBe("timeout");
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGTERM");
      },
      120_000,
    );

    it(
      "init container failure -> workspace_init_failed",
      async () => {
        const fx = await setupFailureCaseFixture(
          client,
          connection,
          "fail-init",
          "init-agent",
          "01testinitfail0000000000001",
        );
        const jobSpec = buildBusyboxTestJob({
          namespace: fx.namespace,
          jobName: fx.jobName,
          pvcName: fx.pvcName,
          envSecretName: fx.secretName,
          initScript: "echo init-failing; exit 2",
          agentScript: "echo never reached; exit 0",
          activeDeadlineSeconds: 60,
        });
        const created = await client.batch.createNamespacedJob(fx.namespace, jobSpec);
        await patchEphemeralSecretOwnerReference(
          client,
          fx.namespace,
          fx.secretName,
          { name: fx.jobName, uid: created.body.metadata!.uid! },
        );

        // Init exits 2; restartPolicy=Never on the pod template + backoffLimit=0
        // means the Job marks failed once the pod's init terminates non-zero.
        const pod = await pollUntil<V1Pod>(async () => {
          const p = await findPod(client, fx.namespace, fx.jobName);
          const ic = p?.status?.initContainerStatuses?.find((s) => s.name === "init");
          if (ic?.state?.terminated && ic.state.terminated.exitCode !== 0) return p;
          return undefined;
        }, 60_000);
        expect(pod, "expected init container to terminate non-zero").toBeTruthy();

        // Wait for the Job to also surface failed status so mapTerminalState's
        // input mirrors what the driver would observe at terminal time.
        const terminalJob = await pollUntil<V1Job>(async () => {
          const j = await client.batch.readNamespacedJob(fx.jobName, fx.namespace);
          if ((j.body.status?.failed ?? 0) >= 1) return j.body;
          return undefined;
        }, 60_000);
        expect(terminalJob, "expected Job.status.failed >= 1").toBeTruthy();

        const result = mapTerminalState({ job: terminalJob!, pod });
        expect(result.errorCode).toBe("workspace_init_failed");
        expect(result.exitCode).toBeNull();
        expect(result.timedOut).toBe(false);
        expect(result.errorMessage).toMatch(/Init container init exited 2/);
      },
      120_000,
    );
  },
);
