/**
 * End-to-end integration test against a local kind cluster.
 *
 * PREREQUISITES (operator must perform before running this test):
 *   1. Create the kind cluster:
 *        kind create cluster --name paperclip
 *   2. Pre-load the alpine image so the Job can start without network access:
 *        docker pull alpine:3.20
 *        docker tag alpine:3.20 localhost/paperclip-agent:latest
 *        kind load docker-image localhost/paperclip-agent:latest --name paperclip
 *   3. For the sandbox-cr backend test, the agent-sandbox controller must be installed:
 *        kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml
 *      And a tini-bearing image pre-loaded (e.g. the same localhost/paperclip-agent:latest
 *      if it includes /usr/bin/tini and /bin/sh).
 *   4. Set the env var and run:
 *        RUN_K8S_INTEGRATION_TESTS=1 pnpm test
 *
 * The namespace is derived from companySlug ("spike-e2e") + namespacePrefix
 * ("paperclip-"), resolving to "paperclip-spike-e2e".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import plugin from "../../src/plugin.js";
import { createKubeConfig } from "../../src/kube-client.js";
import { execInPod } from "../../src/pod-exec.js";
import { sandboxCrOrchestrator } from "../../src/sandbox-cr-orchestrator.js";
import { deleteNamespaceIfExists, kubectl, readKindKubeconfig } from "./_kind-harness.js";

const NAMESPACE = "paperclip-spike-e2e";

describe("plugin-kubernetes end-to-end", () => {
  beforeAll(() => {
    if (process.env.RUN_K8S_INTEGRATION_TESTS !== "1") return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  afterAll(() => {
    if (process.env.RUN_K8S_INTEGRATION_TESTS !== "1") return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  // ── Job backend (stable fallback) ─────────────────────────────────────────

  it.runIf(process.env.RUN_K8S_INTEGRATION_TESTS === "1")(
    "[job backend] acquireLease creates tenant + Job + supporting resources; releaseLease cascade-deletes them",
    async () => {
      const kubeconfig = readKindKubeconfig();
      const config = {
        inCluster: false,
        kubeconfig,
        companySlug: "spike-e2e",
        adapterType: "claude_local",
        backend: "job",
        imageAllowList: [] as string[],
        podActivityDeadlineSec: 60,
        jobTtlSecondsAfterFinished: 60,
      };

      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        config,
        runId: "r-test-e2e-job",
        companyId: "11111111-1111-1111-1111-111111111111",
        environmentId: "env-test",
      });

      expect(lease.providerLeaseId).toMatch(/^pc-/);

      // Verify the Job exists in the tenant namespace
      const jobs = kubectl(`get jobs -n ${NAMESPACE} -o name`);
      expect(jobs).toContain(`job.batch/${lease.providerLeaseId}`);

      // Verify the tenant namespace has the expected supporting resources
      const all = kubectl(
        `get sa,role,rolebinding,resourcequota,limitrange,networkpolicy -n ${NAMESPACE} -o name`,
      );
      expect(all).toContain("serviceaccount/paperclip-tenant-sa");
      expect(all).toContain("role.rbac.authorization.k8s.io/paperclip-tenant-role");
      expect(all).toContain("rolebinding.rbac.authorization.k8s.io/paperclip-tenant-rb");
      expect(all).toContain("resourcequota/paperclip-quota");
      expect(all).toContain("limitrange/paperclip-limits");
      expect(all).toContain("networkpolicy.networking.k8s.io/paperclip-deny-all");
      expect(all).toContain("networkpolicy.networking.k8s.io/paperclip-egress-allow");

      // Verify the namespace has PSS-restricted labels
      const ns = kubectl(`get namespace ${NAMESPACE} -o jsonpath='{.metadata.labels}'`);
      expect(ns).toContain("pod-security.kubernetes.io/enforce");
      expect(ns).toContain("restricted");

      // Verify the per-run Secret exists (owned by the Job for cascade deletion)
      const secrets = kubectl(`get secrets -n ${NAMESPACE} -o name`);
      expect(secrets).toContain(`secret/${lease.providerLeaseId}-env`);

      // Release — deletes the Job with Foreground propagation, which cascade-deletes
      // the owned Secret via owner references set at acquireLease time.
      await plugin.definition.onEnvironmentReleaseLease!({
        driverKey: "kubernetes",
        config,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
        companyId: "11111111-1111-1111-1111-111111111111",
        environmentId: "env-test",
      });

      // Allow a brief grace window for Foreground propagation to finish.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const jobsAfter = kubectl(`get jobs -n ${NAMESPACE} -o name 2>&1 || true`);
      expect(jobsAfter).not.toContain(`job.batch/${lease.providerLeaseId}`);
    },
    180_000,
  );

  // ── Sandbox-CR backend (alpha, requires agent-sandbox controller) ──────────

  it.runIf(process.env.RUN_K8S_INTEGRATION_TESTS === "1")(
    "[sandbox-cr backend] acquireLease creates Sandbox CR + supporting resources; pod becomes Ready; execInPod runs echo hello; releaseLease deletes CR",
    async () => {
      const kubeconfig = readKindKubeconfig();
      const config = {
        inCluster: false,
        kubeconfig,
        companySlug: "spike-e2e",
        adapterType: "claude_local",
        backend: "sandbox-cr",
        imageAllowList: [] as string[],
        podActivityDeadlineSec: 120,
        jobTtlSecondsAfterFinished: 60,
      };

      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        config,
        runId: "r-test-e2e-sandbox-cr",
        companyId: "22222222-2222-2222-2222-222222222222",
        environmentId: "env-test-cr",
      });

      expect(lease.providerLeaseId).toMatch(/^pc-/);

      // Verify the Sandbox CR exists in the tenant namespace
      const sandboxes = kubectl(
        `get sandboxes.agents.x-k8s.io -n ${NAMESPACE} -o name 2>&1`,
      );
      expect(sandboxes).toContain(`sandbox.agents.x-k8s.io/${lease.providerLeaseId}`);

      // Verify the per-run Secret exists (owned by the Sandbox CR)
      const secrets = kubectl(`get secrets -n ${NAMESPACE} -o name`);
      expect(secrets).toContain(`secret/${lease.providerLeaseId}-env`);

      // Wait for the Sandbox pod to become Ready
      const kc = createKubeConfig({ inCluster: false, kubeconfig });
      const { makeKubeClients } = await import("../../src/kube-client.js");
      const clients = makeKubeClients(kc);

      await sandboxCrOrchestrator.waitForCompletion(
        clients,
        NAMESPACE,
        lease.providerLeaseId,
        { timeoutMs: 90_000, pollMs: 3000 },
      );

      // Resolve the pod name
      const podName = await sandboxCrOrchestrator.findPod(
        clients,
        NAMESPACE,
        lease.providerLeaseId,
      );
      expect(podName).toBeTruthy();

      // Exec a simple echo command into the running pod
      const execResult = await execInPod(
        kc,
        NAMESPACE,
        podName!,
        "agent",
        ["echo", "hello"],
      );

      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout.trim()).toBe("hello");

      // Release — deletes the Sandbox CR with Foreground propagation.
      await plugin.definition.onEnvironmentReleaseLease!({
        driverKey: "kubernetes",
        config,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
        companyId: "22222222-2222-2222-2222-222222222222",
        environmentId: "env-test-cr",
      });

      // Allow a brief grace window for Foreground propagation.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const sandboxesAfter = kubectl(
        `get sandboxes.agents.x-k8s.io -n ${NAMESPACE} -o name 2>&1 || true`,
      );
      expect(sandboxesAfter).not.toContain(
        `sandbox.agents.x-k8s.io/${lease.providerLeaseId}`,
      );
    },
    300_000,
  );
});
