import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKubernetesApiClient } from "../../src/index.js";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * M3b Task 13: smoke test for the `agent-runtime-pi` runtime image.
 *
 * Scope: prove that the freshly built image:
 *   - boots in a kind cluster
 *   - has the `pi` CLI on PATH (matching the shim's exec.LookPath
 *     contract)
 *
 * This is intentionally a thin probe — it does NOT exercise the full driver
 * orchestration (covered by claude-end-to-end.test.ts and the unit tests on
 * driver.run()) nor any real provider API (which would require a live key).
 *
 * Gated on K8S_INTEGRATION so contributors without docker + kind on PATH can
 * still run the full unit suite.
 */
describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "pi_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-pi:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      // Build base + pi into the local docker daemon, then load into kind.
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "pi.tags=${IMAGE}" --set "*.platforms=linux/amd64" base pi`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, {
        stdio: "inherit",
      });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-pi image boots and `pi` is on PATH", () => {
      // Construct the API client purely to assert the connection shape this
      // package exports remains compatible with pi_local runtime usage.
      // The actual probe is a kubectl-driven Pod since the smoke test does
      // not need the full orchestrator path.
      createKubernetesApiClient({
        id: "c-1",
        label: "kind",
        kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        imageAllowlist: [],
        capabilities: {
          cilium: false,
          storageClass: "standard",
          architectures: ["amd64"],
        },
      });

      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: pi-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "command -v pi && echo PI_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, {
        env,
        shell: "/bin/bash",
      });
      execSync(
        `kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/pi-probe --timeout=120s`,
        { env },
      );
      const logs = execSync(`kubectl logs pod/pi-probe`, { env }).toString();
      expect(logs).toContain("PI_OK");
    }, 600_000);
  },
);
