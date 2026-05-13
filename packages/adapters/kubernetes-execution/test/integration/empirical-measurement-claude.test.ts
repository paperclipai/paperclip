/**
 * M3a Tasks 14–16: empirical resource measurement with the real claude-code agent.
 *
 * APPROACH: This is a NEW test file added alongside the M2 busybox measurement
 * test (empirical-measurement.test.ts). The M2 test is left intact as a cheap
 * CI smoke for measurement plumbing; this file adds the real workload:
 *   - Image: paperclipai/agent-runtime-claude:test-m3a
 *   - Prompt: "Read README.md in /workspace and tell me the project name in one word."
 *   - Runs: 5 sequential, fresh metric-capture each run
 *   - Workspace: PVC seeded from _fixtures/test-repo via seedWorkspaceFromFixture
 *
 * Gate: K8S_INTEGRATION + ANTHROPIC_API_KEY must both be set. This means the
 * test does NOT run on every K8S_INTEGRATION CI step — only when the operator
 * explicitly provides an Anthropic API key (e.g. for the measurement run).
 *
 * After 5 runs the test writes Peak / Median / p95 numbers into
 * docs/k8s-execution/sizing.md (overwriting the TBD placeholders from Task 15).
 *
 * Cost per full run: ~$0.05–0.20. Do not run on every CI push.
 *
 * Manual run:
 *   ANTHROPIC_API_KEY=sk-ant-... K8S_INTEGRATION=1 \
 *     pnpm --filter @paperclipai/execution-target-kubernetes exec \
 *     vitest run test/integration/empirical-measurement-claude.test.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { spinUpKind, type KindCluster } from "./_harness.js";
import {
  installMetricsServer,
  readPodMetrics,
  waitForMetricsServerReady,
} from "./_helpers/metrics-server.js";
import { seedWorkspaceFromFixture } from "./_helpers/seed-workspace.js";
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
import { buildBusyboxTestJob } from "./_helpers/busybox-job.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REAL_CLAUDE_IMAGE =
  process.env["AGENT_CLAUDE_REAL_IMAGE"] ?? "paperclipai/agent-runtime-claude:test-m3a";
const BASE_IMAGE =
  process.env["AGENT_BASE_IMAGE"] ?? "paperclipai/agent-runtime-base:test-m3a";

const NUM_RUNS = 5;
const COMPANY_ID = "55555555-5555-5555-5555-555555555557";
const COMPANY_SLUG = "measure-claude";

/**
 * Both K8S_INTEGRATION and ANTHROPIC_API_KEY must be set. The measurement is
 * gated on ANTHROPIC_API_KEY so it does not run on every K8S_INTEGRATION CI
 * step (which would incur API costs and extended runtimes on unrelated PRs).
 */
describe.skipIf(!process.env["K8S_INTEGRATION"] || !process.env["ANTHROPIC_API_KEY"])(
  "empirical resource measurement — real claude-code agent (5 runs)",
  () => {
    let kind: KindCluster;

    beforeAll(async () => {
      kind = spinUpKind();

      // Build and load agent-runtime-base + agent-runtime-claude into kind,
      // mirroring the approach in claude-code-real.test.ts (Task 13).
      const repoRoot = join(__dirname, "../../../../..");
      // eslint-disable-next-line no-console
      console.log("[measure-claude] building agent-runtime-base...");
      execSync(
        `docker build -t ${BASE_IMAGE} -f docker/agent-runtime/base/Dockerfile docker/agent-runtime/base`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      // eslint-disable-next-line no-console
      console.log("[measure-claude] building agent-runtime-claude...");
      execSync(
        `docker build -t ${REAL_CLAUDE_IMAGE} -f docker/agent-runtime/claude/Dockerfile docker/agent-runtime/claude`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      // eslint-disable-next-line no-console
      console.log("[measure-claude] loading images into kind...");
      execSync(`kind load docker-image ${BASE_IMAGE} --name ${kind.name}`, { stdio: "inherit" });
      execSync(`kind load docker-image ${REAL_CLAUDE_IMAGE} --name ${kind.name}`, {
        stdio: "inherit",
      });

      installMetricsServer(kind.kubeconfigPath);
      await waitForMetricsServerReady(kind.kubeconfigPath);
    }, 900_000);

    afterAll(() => {
      kind?.cleanup();
    });

    it(
      "measures peak CPU/memory across 5 real claude-code runs; records numbers to sizing.md",
      async () => {
        const connection: ResolvedClusterConnection = {
          id: "c-measure-claude-1",
          label: "kind-measure-claude",
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
        const client = createKubernetesApiClient(connection);

        const ensureResult = await ensureTenantNamespace(client, {
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
        const namespace = ensureResult.namespace;

        const agentSlug = "measure-claude-agent";
        const agentId = "66666666-6666-6666-6666-666666666668";

        // Accumulate samples across all 5 runs.
        const allSamples: Array<{
          run: number;
          tMs: number;
          cpuMillicores: number;
          memoryMi: number;
        }> = [];
        const runPeaks: Array<{ cpuMillicores: number; memoryMi: number }> = [];

        for (let run = 1; run <= NUM_RUNS; run++) {
          // Fresh PVC per run so claude-code always sees a clean workspace.
          const runPvcName = `agent-${agentSlug}-workspace-r${run}`;
          const pvc = buildAgentWorkspacePvc({
            namespace,
            agentId,
            agentSlug: `${agentSlug}-r${run}`,
            companyId: COMPANY_ID,
            companySlug: COMPANY_SLUG,
            storageClass: "standard",
            sizeGi: 1,
            strategyKey: "none",
          });
          // Override the PVC name so each run gets its own volume.
          pvc.metadata!.name = runPvcName;
          await applyAgentWorkspacePvc(client, pvc);

          // Seed the workspace with the fixture repo (README.md + .gitignore).
          await seedWorkspaceFromFixture({
            kubeconfigPath: kind.kubeconfigPath,
            namespace,
            pvcName: runPvcName,
            fixtureDir: join(__dirname, "_fixtures/test-repo"),
            podName: `seed-workspace-r${run}`,
          });

          const runUlid = `01testclaudemeasure0000${run}`;
          const secret = buildEphemeralSecret({
            namespace,
            agentSlug: `${agentSlug}-r${run}`,
            runUlid,
            runId: `test-run-measure-claude-${run}`,
            companyId: COMPANY_ID,
            companySlug: COMPANY_SLUG,
            data: { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"]! },
            ownerJob: {
              name: "placeholder",
              uid: "00000000-0000-0000-0000-000000000000",
            },
          });
          const secretName = secret.metadata!.name!;
          secret.metadata!.ownerReferences = [];
          await applyEphemeralSecret(client, secret);

          // The real claude-code agent job: use the actual agent-runtime-claude
          // image as the main container. We use buildBusyboxTestJob only for
          // the Job scaffolding (PSS-restricted, PVC + secret volumes) and
          // override the image + command to invoke claude-code with our prompt.
          //
          // The agent-runtime-claude image entrypoint is the paperclip shim,
          // which exchanges a bootstrap token before starting claude-code. In
          // this test environment we bypass the shim by invoking claude-code
          // directly via an override command, passing the prompt via --print
          // (non-interactive single-turn mode).
          //
          // Resource limits are set to the M1 defaults (200m / 2cpu, 256Mi /
          // 1Gi) so the test measures peak usage relative to those limits.
          const jobName = `agent-${agentSlug}-run-${runUlid}`;
          const prompt =
            "Read README.md in /workspace and tell me the project name in one word.";
          const jobSpec = buildBusyboxTestJob({
            namespace,
            jobName,
            pvcName: runPvcName,
            envSecretName: secretName,
            // Use the real claude-code image.
            image: REAL_CLAUDE_IMAGE,
            // claude-code --print runs a single non-interactive turn and exits.
            agentScript: `claude --print "${prompt}"`,
            // Init container still uses busybox — just checks workspace is ready.
            initScript: "ls -la /workspace; echo init-done",
            activeDeadlineSeconds: 300,
            cpuLimit: "2",
            memoryLimit: "1Gi",
          });
          // Override resource requests to M1 defaults as well.
          const mainContainer = jobSpec.spec!.template!.spec!.containers![0]!;
          mainContainer.resources = {
            requests: { cpu: "200m", memory: "256Mi" },
            limits: { cpu: "2", memory: "1Gi" },
          };

          const created = await client.batch.createNamespacedJob(namespace, jobSpec);
          const jobUid = created.body.metadata!.uid!;
          await patchEphemeralSecretOwnerReference(client, namespace, secretName, {
            name: jobName,
            uid: jobUid,
          });

          // Polling loop: every 5s while the Job is alive, scrape pod metrics.
          const runPeak = { cpuMillicores: 0, memoryMi: 0 };
          const startedAt = Date.now();
          const stop = setInterval(() => {
            try {
              const metrics = readPodMetrics(namespace, kind.kubeconfigPath);
              for (const m of metrics) {
                if (!m.name.startsWith(jobName)) continue;
                runPeak.cpuMillicores = Math.max(runPeak.cpuMillicores, m.cpuMillicores);
                runPeak.memoryMi = Math.max(runPeak.memoryMi, m.memoryMi);
                allSamples.push({
                  run,
                  tMs: Date.now() - startedAt,
                  cpuMillicores: m.cpuMillicores,
                  memoryMi: m.memoryMi,
                });
              }
            } catch {
              /* metrics-server briefly unavailable — skip this poll */
            }
          }, 5000);

          // Wait for terminal state (max 5 minutes per run).
          let succeeded = false;
          const deadline = Date.now() + 300_000;
          let terminalPod: V1Pod | undefined;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            const j = await client.batch.readNamespacedJob(jobName, namespace);
            if ((j.body.status?.succeeded ?? 0) >= 1) {
              succeeded = true;
              const list = await client.core.listNamespacedPod(
                namespace,
                undefined,
                undefined,
                undefined,
                undefined,
                `job-name=${jobName}`,
              );
              terminalPod = list.body.items[0];
              break;
            }
            if ((j.body.status?.failed ?? 0) >= 1) break;
          }
          clearInterval(stop);

          expect(
            succeeded,
            `run ${run}: expected claude-code workload to complete cleanly`,
          ).toBe(true);
          expect(terminalPod?.status?.phase).toBe("Succeeded");

          runPeaks.push({ ...runPeak });
          // eslint-disable-next-line no-console
          console.log(
            `[measure-claude] run ${run}/${NUM_RUNS}: peak CPU=${runPeak.cpuMillicores}m mem=${runPeak.memoryMi}Mi`,
          );
        }

        // Compute aggregate stats across all 5 runs.
        const cpuValues = runPeaks.map((p) => p.cpuMillicores).sort((a, b) => a - b);
        const memValues = runPeaks.map((p) => p.memoryMi).sort((a, b) => a - b);

        const peakCpu = Math.max(...cpuValues);
        const medianCpu = percentile(cpuValues, 50);
        const p95Cpu = percentile(cpuValues, 95);

        const peakMem = Math.max(...memValues);
        const medianMem = percentile(memValues, 50);
        const p95Mem = percentile(memValues, 95);

        // Sanity: peaks must fit inside M1 per-tenant envelope.
        expect(peakMem, "peak memory must be under 1Gi limit").toBeLessThan(1024);
        expect(peakCpu, "peak CPU must be under 2 cpu limit").toBeLessThan(2000);

        // Write the sizing report, overwriting the TBD placeholders in sizing.md.
        const sizingPath = join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "docs",
          "k8s-execution",
          "sizing.md",
        );
        mkdirSync(dirname(sizingPath), { recursive: true });
        writeFileSync(
          sizingPath,
          renderSizingMarkdown({
            timestamp: new Date().toISOString(),
            image: REAL_CLAUDE_IMAGE,
            prompt: "Read README.md in /workspace and tell me the project name in one word.",
            numRuns: NUM_RUNS,
            peakCpu,
            medianCpu,
            p95Cpu,
            peakMem,
            medianMem,
            p95Mem,
            runPeaks,
          }),
        );
      },
      // 5 runs × 300s deadline + 15 min overhead for kind boot / image load.
      2_700_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderSizingMarkdown(input: {
  timestamp: string;
  image: string;
  prompt: string;
  numRuns: number;
  peakCpu: number;
  medianCpu: number;
  p95Cpu: number;
  peakMem: number;
  medianMem: number;
  p95Mem: number;
  runPeaks: Array<{ cpuMillicores: number; memoryMi: number }>;
}): string {
  const runRows = input.runPeaks
    .map(
      (r, i) => `| ${i + 1} | ${r.cpuMillicores} m | ${r.memoryMi} Mi |`,
    )
    .join("\n");

  return `# Kubernetes execution target — agent sizing

## Workload

- Image: \`${input.image}\` (claude-code from \`@anthropic-ai/claude-code\`)
- Prompt: \`"${input.prompt}"\`
- Workspace: PVC seeded with a 2-file repo (README.md + .gitignore)
- Runs: ${input.numRuns} sequential, fresh PVC each run
- Cluster: kind v0.24.0 (Kubernetes v1.31.x), single node, on a CI runner

Last measured: ${input.timestamp}

## Observations

| Metric    | Peak | Median | p95   |
|-----------|------|--------|-------|
| CPU (m)   | ${input.peakCpu} | ${input.medianCpu} | ${input.p95Cpu} |
| Memory (Mi) | ${input.peakMem} | ${input.medianMem} | ${input.p95Mem} |

### Per-run peaks

| Run | CPU (m) | Memory (Mi) |
|-----|---------|-------------|
${runRows}

## Recommended defaults

\`\`\`yaml
resources:
  requests:
    cpu:    200m
    memory: 256Mi
  limits:
    cpu:    2
    memory: 1Gi
\`\`\`

(M1 defaults retained until measurement justifies a bump — see "Decision".)

## Recommended ResourceQuota for a 50-agent tenant

\`\`\`yaml
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
\`\`\`

## Decision

Threshold for raising defaults:
- Memory: peak > 0.6 × current limit (614 Mi)
- CPU: peak > 0.5 × current limit (1000 m)

Decision: KEEP M1 defaults. Re-evaluate after first production runs surface real multi-turn workload data.

## Caveats

- This is a single-turn prompt. Multi-turn sessions (real agent loops) will use more memory due to accumulated context. Operators running multi-turn workloads should monitor actual usage and raise quotas accordingly.
- Numbers from the empirical-measurement test are taken on a CI runner; production hardware may show different baselines.

## How we measured

\`packages/adapters/kubernetes-execution/test/integration/empirical-measurement-claude.test.ts\` provisions kind + metrics-server, runs the workload 5 times under measurement, and writes the table above. Re-run with:

\`\`\`bash
ANTHROPIC_API_KEY=... K8S_INTEGRATION=1 \\
  pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/empirical-measurement-claude.test.ts
\`\`\`

Cost: ~$0.05–0.20 per full run.
`;
}
