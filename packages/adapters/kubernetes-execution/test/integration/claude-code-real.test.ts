/**
 * M3a Task 13: Real claude-code on kind, gated on K8S_INTEGRATION + ANTHROPIC_API_KEY.
 *
 * DONE_WITH_CONCERNS notes:
 *
 * 1. workspaceStrategyJson — The init container reads PAPERCLIP_WORKSPACE_REQUEST.
 *    We pass `{"version":1,"source":{"strategy":"noop"}}` under the assumption the
 *    workspace-init binary accepts a "noop" source strategy (i.e. does nothing and
 *    treats the already-populated PVC as the workspace). If the init image requires
 *    a different strategy key or schema version, the init container will exit
 *    non-zero and the pod will fail before claude-code even starts. Adjust
 *    workspaceStrategyJson to match the contract the real workspace-init binary
 *    expects, or use imageOverride on the target to skip the init container.
 *
 * 2. Bootstrap token exchange — The shim exchanges the minted token via
 *    POST PAPERCLIP_PUBLIC_URL/api/agent-auth/exchange. We pass
 *    "http://example.invalid" which will cause the exchange to fail immediately.
 *    Whether this terminates the process before claude-code runs depends on the
 *    shim's error-handling. If the shim is strict (exits on exchange failure),
 *    the run will exit non-zero. In that case: either run a real control-plane
 *    reachable from the kind node, or modify the shim to accept a
 *    PAPERCLIP_SKIP_AUTH_EXCHANGE env var (a test-only escape hatch).
 *
 * 3. PVC pre-population — We seed the workspace before driver.run() via
 *    seedWorkspaceFromFixture. The driver also calls applyAgentWorkspacePvc
 *    (idempotent), so the PVC must not be bound to a different StorageClass. We
 *    pass storageClassName: "standard" in resolveRunContext to match kind's default.
 *
 * Manual run procedure (once K8S_INTEGRATION + ANTHROPIC_API_KEY are available):
 *
 *   K8S_INTEGRATION=1 ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @paperclipai/execution-target-kubernetes exec \
 *     vitest run test/integration/claude-code-real.test.ts
 *
 * Expected: PASS in ~3–5 minutes (kind boot ~90s + image load ~60s + agent run).
 * Cost: ~$0.01–0.05 per run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { seedWorkspaceFromFixture } from "./_helpers/seed-workspace.js";
import {
  createKubernetesApiClient,
  createKubernetesExecutionDriver,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REAL_CLAUDE_IMAGE =
  process.env["AGENT_CLAUDE_REAL_IMAGE"] ?? "paperclipai/agent-runtime-claude:test-m3a";
const BASE_IMAGE =
  process.env["AGENT_BASE_IMAGE"] ?? "paperclipai/agent-runtime-base:test-m3a";

const COMPANY_ID = "55555555-5555-5555-5555-555555555556";
const COMPANY_SLUG = "claudereal";
const AGENT_ID = "66666666-6666-6666-6666-666666666667";
const CONNECTION_ID = "c-real-1";

describe.skipIf(!process.env["K8S_INTEGRATION"] || !process.env["ANTHROPIC_API_KEY"])(
  "real claude-code on kind",
  () => {
    let kind: KindCluster;
    let connection: ResolvedClusterConnection;

    beforeAll(async () => {
      kind = spinUpKind();

      // Build agent-runtime-base + agent-runtime-claude and load both into kind.
      const repoRoot = path.resolve(__dirname, "../../../../..");
      // eslint-disable-next-line no-console
      console.log("[claude-code-real] building agent-runtime-base...");
      execSync(
        `docker build -t ${BASE_IMAGE} -f docker/agent-runtime/base/Dockerfile docker/agent-runtime/base`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      // eslint-disable-next-line no-console
      console.log("[claude-code-real] building agent-runtime-claude...");
      execSync(
        `docker build -t ${REAL_CLAUDE_IMAGE} -f docker/agent-runtime/claude/Dockerfile docker/agent-runtime/claude`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      // eslint-disable-next-line no-console
      console.log("[claude-code-real] loading images into kind...");
      execSync(`kind load docker-image ${BASE_IMAGE} --name ${kind.name}`, { stdio: "inherit" });
      execSync(`kind load docker-image ${REAL_CLAUDE_IMAGE} --name ${kind.name}`, { stdio: "inherit" });

      connection = {
        id: CONNECTION_ID,
        label: "kind-real",
        kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: {
          cilium: false,
          storageClass: "standard",
          architectures: ["amd64", "arm64"],
        },
      };
    }, 900_000);

    afterAll(() => kind?.cleanup());

    it(
      "reads README.md via tool-use and surfaces the project name in logs",
      async () => {
        const client = createKubernetesApiClient(connection);

        // 1. Ensure tenant namespace.
        const ensure = await ensureTenantNamespace(client, {
          connection,
          company: { id: COMPANY_ID, slug: COMPANY_SLUG },
          tenantPolicy: null,
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: {
            topology: "cross-cluster",
            namespaceLabels: {},
            podLabels: {},
          },
          adapterAllowFqdns: ["api.anthropic.com"],
          imagePullDockerConfigJson: null,
        });
        const namespace = ensure.namespace;
        // Always-hash namespace shape: paperclip-<slug>-<8-char-hash(companyId)>.
        // See M3b Task 17 / orchestrator/naming.ts for the rationale.
        expect(namespace).toMatch(new RegExp(`^paperclip-${COMPANY_SLUG}-[0-9a-z]{8}$`));

        // 2. Apply PVC (driver will also call applyAgentWorkspacePvc, which is
        //    idempotent; we apply it first so seedWorkspaceFromFixture can bind it).
        execSync(
          [
            `kubectl --kubeconfig ${kind.kubeconfigPath}`,
            `-n ${namespace} apply -f -`,
          ].join(" "),
          {
            input: [
              "apiVersion: v1",
              "kind: PersistentVolumeClaim",
              "metadata:",
              "  name: agent-claudereal-workspace",
              `  namespace: ${namespace}`,
              "spec:",
              "  accessModes: [ReadWriteOnce]",
              "  resources:",
              "    requests:",
              "      storage: 1Gi",
              "  storageClassName: standard",
            ].join("\n"),
            stdio: ["pipe", "inherit", "inherit"],
          },
        );

        // 3. Seed the workspace with the fixture repo.
        await seedWorkspaceFromFixture({
          kubeconfigPath: kind.kubeconfigPath,
          namespace,
          pvcName: "agent-claudereal-workspace",
          fixtureDir: path.resolve(__dirname, "_fixtures/test-repo"),
        });

        // 4. Collect logs via onLog callback (AdapterExecutionResult has no logs field).
        const collectedLogs: string[] = [];

        // 5. Wire up the driver.
        const driver = createKubernetesExecutionDriver({
          resolveConnection: async (id) => {
            if (id === CONNECTION_ID) return connection;
            return null;
          },
          bootstrapTokenMinter: {
            mint: async () => ({
              token: "bst_test_unused",
              expiresAt: new Date(Date.now() + 600_000),
            }),
          },
          resolveRunContext: async () => ({
            companySlug: COMPANY_SLUG,
            image: REAL_CLAUDE_IMAGE,
            initImage: BASE_IMAGE,
            paperclipPublicUrl: "http://example.invalid",
            workspaceStrategyJson: JSON.stringify({ version: 1, source: { strategy: "noop" } }),
            workspaceStrategyKey: "claudereal-noop",
            storageClassName: "standard",
            storageSizeGi: 1,
            adapterEnv: {
              ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"]!,
            },
          }),
          pollIntervalMs: 2000,
        });

        // 6. Run the driver.
        const result = await driver.run({
          ctx: {
            runId: "r-real-1",
            agent: {
              id: AGENT_ID,
              companyId: COMPANY_ID,
              name: "real-claude-test-agent",
              adapterType: "claude_local",
              adapterConfig: {},
            },
            runtime: {
              sessionId: null,
              sessionParams: null,
              sessionDisplayId: null,
              taskKey: null,
            },
            config: {},
            context: {},
            onLog: async (_stream, chunk) => {
              collectedLogs.push(chunk);
            },
          },
          target: {
            kind: "kubernetes",
            clusterConnectionId: CONNECTION_ID,
          },
        });

        // 7. Assertions.
        const joinedLogs = collectedLogs.join("\n");
        if (result.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn("[claude-code-real] non-zero exit. result:", result, "\nlogs:\n", joinedLogs);
        }
        expect(result.exitCode, `expected exit 0; logs:\n${joinedLogs}`).toBe(0);
        expect(
          joinedLogs.toLowerCase(),
          "expected 'paperclip-claude-test' in pod logs",
        ).toContain("paperclip-claude-test");
      },
      900_000,
    );
  },
);
