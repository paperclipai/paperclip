import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { installCilium, waitForCiliumReady } from "./_helpers/cilium.js";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";

const exec = promisify(execCb);

/**
 * M3a Task 9: kind+Cilium integration test for the per-tenant Cilium DSL.
 *
 * Requires the Cilium CLI on PATH (`brew install cilium-cli` or per
 * https://docs.cilium.io/en/stable/gettingstarted/k8s-install-default/#install-the-cilium-cli).
 *
 * Opt-in via two env vars: K8S_INTEGRATION (gates all kind tests in this
 * suite) AND K8S_CILIUM_INTEGRATION (gates the slow Cilium-installing
 * tests specifically). The full run takes ~3–5 minutes on a warm Docker
 * layer cache.
 */

describe.skipIf(!process.env["K8S_INTEGRATION"] || !process.env["K8S_CILIUM_INTEGRATION"])(
  "tenant Cilium DSL on kind+Cilium",
  () => {
    let kind: KindCluster;
    let connection: ResolvedClusterConnection;

    beforeAll(async () => {
      kind = spinUpKind();
      installCilium(kind.kubeconfigPath);
      waitForCiliumReady(kind.kubeconfigPath);
      connection = {
        id: "c-1", label: "kind-cilium", kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: true, storageClass: "standard", architectures: ["amd64"] },
      };
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it(
      "blocks egress to a host not in dnsAllowlist while permitting one that is",
      async () => {
        const client = createKubernetesApiClient(connection);
        await ensureTenantNamespace(client, {
          connection,
          company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme" },
          tenantPolicy: {
            quota: null, limitRange: null,
            additionalAllowFqdns: [],
            imageOverrides: null,
            ciliumDnsAllowlist: ["example.com"],
            ciliumEgressCidrs: [],
          },
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
          adapterAllowFqdns: [],
          imagePullDockerConfigJson: null,
        });

        // Wait for Cilium to ingest the baseline CNP. Tenant Cilium allowlists
        // are folded into this single policy because Cilium allow policies are
        // additive; a second allow CNP would widen egress instead of narrowing it.
        await new Promise((r) => setTimeout(r, 3000));

        // Run a probe pod with the agent label so it matches the CNP endpointSelector.
        const probeYaml = `apiVersion: v1
kind: Pod
metadata:
  name: probe
  namespace: paperclip-acme
  labels:
    paperclip.ai/managed-by: paperclip
    paperclip.ai/role: agent-runtime
spec:
  containers:
    - name: c
      image: curlimages/curl:8.10.1
      command: ["sh", "-c", "sleep 3600"]
`;
        const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
        await exec(`kubectl apply -f - <<'EOF'
${probeYaml}
EOF`, { env, shell: "/bin/bash" });
        await exec(`kubectl wait --for=condition=Ready pod/probe -n paperclip-acme --timeout=60s`, { env });

        // Allowed: example.com (in dnsAllowlist).
        const allowed = await exec(
          `kubectl exec -n paperclip-acme probe -- ` +
          `curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com`,
          { env },
        ).catch((e) => ({ stdout: "ERR", stderr: String(e) }));
        // 200/301/302 etc. all acceptable — what matters is the connection succeeded.
        expect(allowed.stdout.trim()).toMatch(/^(2..|3..)$/);

        // Blocked: github.com (not in dnsAllowlist; the effective CNP only
        // permits example.com plus control-plane egress).
        const blocked = await exec(
          `kubectl exec -n paperclip-acme probe -- ` +
          `curl -sS -m 8 -o /dev/null -w "%{http_code}" https://github.com`,
          { env },
        ).catch((e) => ({ stdout: "ERR", stderr: String(e) }));
        // Cilium drops the connection: curl exits non-zero (catch path) OR
        // returns "000" (no HTTP response received).
        expect(blocked.stdout === "ERR" || blocked.stdout.trim() === "000").toBe(true);
      },
      300_000,
    );
  },
);
