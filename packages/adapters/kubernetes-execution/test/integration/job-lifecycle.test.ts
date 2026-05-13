import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { startLogStream } from "../../src/orchestrator/log-stream.js";
import { mapTerminalState } from "../../src/orchestrator/failure-mapping.js";
import { cancelJob } from "../../src/orchestrator/cancellation.js";
import { buildBusyboxTestJob } from "./_helpers/busybox-job.js";

/**
 * End-to-end integration test for the M2 Job lifecycle wiring.
 *
 * What this test PROVES against a real kind cluster:
 *   - ensureTenantNamespace() lays down a usable namespace.
 *   - applyAgentWorkspacePvc() creates a PVC bound by kind's default storage class.
 *   - applyEphemeralSecret() creates a Secret whose values land in the agent
 *     container via envFrom.
 *   - createNamespacedJob() with a Restricted-PSS-compliant pod spec is
 *     accepted and runs to completion.
 *   - patchEphemeralSecretOwnerReference() wires the OwnerReference back to
 *     the Job UID so the Secret is GC'd with the Job.
 *   - startLogStream() yields the agent's stdout chunks while the pod runs.
 *   - mapTerminalState() returns exitCode=0 / no errorCode on success.
 *
 * What this test does NOT exercise: the agent-shim contract, workspace-init,
 * the bootstrap-token exchange flow. Those are covered by the unit tests on
 * `buildAgentJob()` and by Task 26's claude_local end-to-end test.
 */
describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "Job lifecycle (busybox) on kind",
  () => {
    let kind: KindCluster;
    beforeAll(() => {
      kind = spinUpKind();
    }, 240_000);
    afterAll(() => {
      kind?.cleanup();
    });

    it(
      "creates Namespace+PVC+Secret+Job, streams logs, and reports success via mapTerminalState",
      async () => {
        const connection: ResolvedClusterConnection = {
          id: "c-1",
          label: "kind",
          kind: "kubeconfig",
          kubeconfigYaml: kind.kubeconfigYaml,
          defaultNamespacePrefix: "paperclip-",
          allowAgentImageOverride: false,
          capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
        };
        const client = createKubernetesApiClient(connection);

        // 1. Tenant namespace.
        const companyId = "11111111-1111-1111-1111-111111111111";
        const companySlug = "lifecycle";
        const ensureResult = await ensureTenantNamespace(client, {
          connection,
          company: { id: companyId, slug: companySlug },
          tenantPolicy: null,
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
          adapterAllowFqdns: [],
          imagePullDockerConfigJson: null,
        });
        const namespace = ensureResult.namespace;
        expect(namespace).toBe("paperclip-lifecycle");

        // 2. PVC. kind 0.20+ ships `standard` as the default StorageClass via
        // the rancher local-path provisioner.
        const agentSlug = "lifecycle-agent";
        const pvc = buildAgentWorkspacePvc({
          namespace,
          agentId: "22222222-2222-2222-2222-222222222222",
          agentSlug,
          companyId,
          companySlug,
          storageClass: "standard",
          sizeGi: 1,
          strategyKey: "none",
        });
        await applyAgentWorkspacePvc(client, pvc);

        // 3. Build the Job + Secret with matching names so envFrom resolves
        //    correctly. We follow Task 23's two-phase commit: create Secret
        //    first (no OwnerRef), create Job, then patch OwnerRef to Job UID.
        // ULIDs are normally uppercase Crockford base32, but k8s object names
        // must be DNS-1123 (lowercase). The driver lowercases the ULID before
        // using it as a name suffix; we mirror that here.
        const runUlid = "01testlifecycle0000000001";
        const runId = "test-run-1";
        const secret = buildEphemeralSecret({
          namespace,
          agentSlug,
          runUlid,
          runId,
          companyId,
          companySlug,
          data: {
            MY_KEY: "the-secret-value",
            BOOTSTRAP_TOKEN: "bst_test_placeholder",
          },
          // Placeholder OwnerRef — overwritten by patchEphemeralSecretOwnerReference
          // below once we know the Job UID. We set it here only because
          // buildEphemeralSecret requires it; we strip it before applying.
          ownerJob: { name: "placeholder", uid: "00000000-0000-0000-0000-000000000000" },
        });
        const secretName = secret.metadata!.name!;
        secret.metadata!.ownerReferences = []; // strip placeholder; will patch later.
        await applyEphemeralSecret(client, secret);

        const jobName = `agent-${agentSlug}-run-${runUlid}`;
        const jobSpec = buildBusyboxTestJob({
          namespace,
          jobName,
          pvcName: pvc.metadata!.name!,
          envSecretName: secretName,
          // The script verifies that:
          //   (a) Secret values reach envFrom (echo $MY_KEY)
          //   (b) Workspace PVC is mounted writable (touch a file)
          //   (c) Process exits 0 cleanly.
          agentScript:
            // sleep BEFORE the echoes so the test's pod-watch loop has time
            // to discover the running container and attach the log stream
            // before output is produced. This avoids racing the kubelet's
            // log-buffer flush against busybox's quick exit on slow CI hosts.
            "sleep 3; " +
            'echo "hello-from-busybox"; ' +
            'echo "MY_KEY=$MY_KEY"; ' +
            'touch /workspace/.lifecycle-test-marker && echo "workspace-write-ok"; ' +
            "sleep 1; exit 0",
        });
        const created = await client.batch.createNamespacedJob(namespace, jobSpec);
        const jobUid = created.body.metadata!.uid!;
        expect(jobUid).toBeTruthy();

        // 3b. Patch the Secret with the Job's OwnerReference so it gets GC'd
        //     with the Job.
        await patchEphemeralSecretOwnerReference(client, namespace, secretName, {
          name: jobName,
          uid: jobUid,
        });
        const patchedSecret = await client.core.readNamespacedSecret(secretName, namespace);
        expect(patchedSecret.body.metadata?.ownerReferences?.[0]?.uid).toBe(jobUid);

        // 4. Wait for the pod's main container to have started (running or
        //    already terminated). `pods/log?follow=true` returns 400
        //    "container is waiting to start" while the pod is Pending or
        //    ContainerCreating, and `startLogStream`'s reconnect loop
        //    interprets non-OK as a permanent error and exits. So we must not
        //    open the stream until the kubelet has actually attached the
        //    container.
        const findPod = async () => {
          const list = await client.core.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `job-name=${jobName}`,
          );
          return list.body.items[0];
        };
        const isAgentContainerStarted = (pod: Awaited<ReturnType<typeof findPod>> | undefined): boolean => {
          const c = pod?.status?.containerStatuses?.find((s) => s.name === "agent");
          if (!c) return false;
          return Boolean(c.state?.running || c.state?.terminated);
        };
        let podName: string | undefined;
        const podDeadline = Date.now() + 90_000;
        while (Date.now() < podDeadline) {
          const pod = await findPod();
          if (pod?.metadata?.name && isAgentContainerStarted(pod)) {
            podName = pod.metadata.name;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(podName).toBeTruthy();

        const logs: string[] = [];
        const logHandle = startLogStream({
          client,
          namespace,
          podName: podName!,
          containerName: "agent",
          onLog: async (_stream, chunk) => {
            logs.push(chunk);
          },
        });

        // 5. Poll the Job status until terminal.
        let terminalJob: typeof created.body | undefined;
        let terminalPod: Awaited<ReturnType<typeof findPod>> | undefined;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const j = await client.batch.readNamespacedJob(jobName, namespace);
          if ((j.body.status?.succeeded ?? 0) >= 1 || (j.body.status?.failed ?? 0) >= 1) {
            terminalJob = j.body;
            terminalPod = await findPod();
            break;
          }
        }
        expect(terminalJob).toBeTruthy();
        expect(terminalJob!.status?.succeeded).toBeGreaterThanOrEqual(1);

        // Stop the log stream and wait for it to drain.
        logHandle.abort();
        await logHandle.done;

        // 6. The log stream must have observed at least one chunk emitted by
        //    the agent script. `pods/log` lines are timestamp-stripped by
        //    startLogStream, so we get the raw container output.
        const joined = logs.join("\n");
        expect(joined).toContain("hello-from-busybox");
        expect(joined).toContain("MY_KEY=the-secret-value");
        expect(joined).toContain("workspace-write-ok");

        // 7. Map terminal state — busybox exited 0, so we expect a clean
        //    success (exitCode 0, no errorCode).
        const result = mapTerminalState({ job: terminalJob!, pod: terminalPod });
        expect(result.exitCode).toBe(0);
        expect(result.errorCode).toBeUndefined();
        expect(result.timedOut).toBe(false);

        // 8. cancelJob should be a clean no-op against an already-completed
        //    Job: foreground delete tears down the Job + the Secret (via
        //    OwnerRef GC). We don't assert post-conditions here because the
        //    primary purpose of this test is the success path; a separate
        //    test in Task 27 covers cancellation mid-flight.
        await cancelJob({ client, namespace, jobName, graceSeconds: 5 });
      },
      300_000,
    );
  },
);
