import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { spinUpKind, type KindCluster } from "./_harness.js";
import {
  installMetricsServer,
  readPodMetrics,
  waitForMetricsServerReady,
} from "./_helpers/metrics-server.js";
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

/**
 * M2 Task 28: empirical resource measurement infrastructure.
 *
 * Provisions kind + metrics-server, runs a fake-agent workload (busybox echo
 * loop) under measurement, captures peak CPU / memory observed via
 * `kubectl top pod`, and writes the numbers to
 * `docs/k8s-execution/sizing-fake-agent.md`.
 *
 * Risk #4 in the M2 design ("empirical resource defaults") is PARTIALLY
 * resolved by this test: the *infrastructure* (metrics-server bootstrap, pod
 * polling, sizing.md generation) ships with M2; the *representative numbers*
 * for real claude_local agents require the M3 agent-runtime-claude image
 * exercising real Anthropic protocol, which is out of M2's scope. M1's
 * resource defaults (256Mi requests / 1Gi limit, 200m / 2cpu) are retained
 * unchanged.
 *
 * The test therefore asserts only sanity bounds (peaks below the per-tenant
 * envelope) — not absolute values, since absolute values are only meaningful
 * once the workload is real.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "empirical resource measurement on kind",
  () => {
    let kind: KindCluster;

    beforeAll(async () => {
      kind = spinUpKind();
      installMetricsServer(kind.kubeconfigPath);
      await waitForMetricsServerReady(kind.kubeconfigPath);
    }, 360_000);

    afterAll(() => {
      kind?.cleanup();
    });

    it(
      "measures peak CPU/memory across a busybox-load run; records numbers; asserts < tenant max",
      async () => {
        const connection: ResolvedClusterConnection = {
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
        const client = createKubernetesApiClient(connection);

        const companyId = "55555555-5555-5555-5555-555555555555";
        const companySlug = "measure";
        const ensureResult = await ensureTenantNamespace(client, {
          connection,
          company: { id: companyId, slug: companySlug },
          tenantPolicy: null,
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: {
            topology: "cross-cluster",
            namespaceLabels: {},
            podLabels: {},
          },
          adapterAllowFqdns: [],
          imagePullDockerConfigJson: null,
        });
        const namespace = ensureResult.namespace;

        const agentSlug = "measure-agent";
        const pvc = buildAgentWorkspacePvc({
          namespace,
          agentId: "66666666-6666-6666-6666-666666666666",
          agentSlug,
          companyId,
          companySlug,
          storageClass: "standard",
          sizeGi: 1,
          strategyKey: "none",
        });
        await applyAgentWorkspacePvc(client, pvc);

        const runUlid = "01testempiricalmeasure00001";
        const secret = buildEphemeralSecret({
          namespace,
          agentSlug,
          runUlid,
          runId: "test-run-empirical",
          companyId,
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
        // Workload: ~75s of mixed echo + arithmetic + brief allocations.
        // metrics-server's default scrape interval is 15s, so we need a
        // workload that runs LONG enough for 3-4 scrapes to land while the
        // pod is alive. (A 10s busybox loop will exit before the first
        // scrape window closes, leaving the test's assertions on `peaks`
        // valid but the sample table empty.) This is still a SANITY workload
        // — busybox's resident set on Alpine hovers around 1-3 MiB and CPU
        // is near zero — but the timeline is long enough to prove the
        // plumbing actually captured numbers.
        const agentScript =
          'sleep 2; ' +
          'for round in $(seq 1 5); do ' +
          '  echo "round $round start"; ' +
          // 200 echoes spaced 50ms = ~10s of light I/O.
          '  for i in $(seq 1 200); do echo "round $round line $i"; sleep 0.05; done; ' +
          // Brief CPU spike: count primes <100k via trial division on busybox sh.
          '  c=0; n=2; while [ $n -lt 5000 ]; do d=2; p=1; while [ $((d*d)) -le $n ]; do if [ $((n % d)) -eq 0 ]; then p=0; break; fi; d=$((d+1)); done; c=$((c+p)); n=$((n+1)); done; ' +
          '  echo "round $round primes=$c"; ' +
          '  sleep 1; ' +
          'done; ' +
          'echo done; exit 0';
        const jobSpec = buildBusyboxTestJob({
          namespace,
          jobName,
          pvcName: pvc.metadata!.name!,
          envSecretName: secretName,
          agentScript,
          activeDeadlineSeconds: 180,
          // The prime-count loop in shell is interpretation-heavy; bump the
          // CPU limit so it doesn't get throttled into a wall-clock blowout.
          cpuLimit: "500m",
        });

        const created = await client.batch.createNamespacedJob(namespace, jobSpec);
        const jobUid = created.body.metadata!.uid!;
        await patchEphemeralSecretOwnerReference(client, namespace, secretName, {
          name: jobName,
          uid: jobUid,
        });

        // Polling loop: every 5s while the Job is alive, scrape pod metrics
        // for the namespace and update peaks. Guard with try/catch — metrics-
        // server can return 503 mid-scrape and that should not fail the test.
        const peaks = { cpuMillicores: 0, memoryMi: 0, samples: 0 };
        const samples: Array<{ tMs: number; cpuMillicores: number; memoryMi: number }> = [];
        const startedAt = Date.now();
        const stop = setInterval(() => {
          try {
            const metrics = readPodMetrics(namespace, kind.kubeconfigPath);
            for (const m of metrics) {
              if (!m.name.startsWith(jobName)) continue;
              peaks.cpuMillicores = Math.max(peaks.cpuMillicores, m.cpuMillicores);
              peaks.memoryMi = Math.max(peaks.memoryMi, m.memoryMi);
              peaks.samples += 1;
              samples.push({
                tMs: Date.now() - startedAt,
                cpuMillicores: m.cpuMillicores,
                memoryMi: m.memoryMi,
              });
            }
          } catch {
            /* metrics-server briefly unavailable — skip this poll */
          }
        }, 5000);

        // Wait for terminal state. The workload runs ~75s of wall-clock; we
        // give a generous 200s deadline to absorb kind's pull/start latency.
        let succeeded = false;
        const deadline = Date.now() + 200_000;
        let terminalPod: V1Pod | undefined;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
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

        expect(succeeded, "expected fake-agent workload to complete cleanly").toBe(true);
        expect(terminalPod?.status?.phase).toBe("Succeeded");

        // Sanity: the busybox echo loop should fit comfortably under the
        // M1 per-tenant envelope (1Gi memory, 2 CPU). The peaks may legitimately
        // be 0 if no scrape landed during the Job's ~12s lifetime — that's fine
        // for the infrastructure smoke; we just record what we saw.
        expect(peaks.memoryMi).toBeLessThan(1024);
        expect(peaks.cpuMillicores).toBeLessThan(2000);

        // Write the sizing report.
        const sizingPath = join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "docs",
          "k8s-execution",
          "sizing-fake-agent.md",
        );
        mkdirSync(dirname(sizingPath), { recursive: true });
        writeFileSync(
          sizingPath,
          renderSizingMarkdown({
            timestamp: new Date().toISOString(),
            agentScript,
            peaks,
            samples,
          }),
        );
      },
      420_000,
    );
  },
);

function renderSizingMarkdown(input: {
  timestamp: string;
  agentScript: string;
  peaks: { cpuMillicores: number; memoryMi: number; samples: number };
  samples: Array<{ tMs: number; cpuMillicores: number; memoryMi: number }>;
}): string {
  const sampleRows =
    input.samples.length === 0
      ? "_(no metrics scrapes landed during the Job's lifetime — the busybox\n  workload completes in ~12s, faster than metrics-server's 15s scrape\n  interval can guarantee. Re-run with a longer-lived workload to populate.)_\n"
      : input.samples
          .map(
            (s) =>
              `| ${(s.tMs / 1000).toFixed(1)}s | ${s.cpuMillicores}m | ${s.memoryMi} Mi |`,
          )
          .join("\n");

  return `# Sizing — fake agent (busybox echo loop)

Last measured: ${input.timestamp}

## Workload

\`\`\`sh
${input.agentScript}
\`\`\`

## Peaks observed via metrics-server

| Metric | Peak |
|---|---|
| CPU | ${input.peaks.cpuMillicores} m |
| Memory | ${input.peaks.memoryMi} Mi |
| Samples observed | ${input.peaks.samples} |

## Sample timeline

| t (s since Job creation) | CPU | Memory |
|---|---|---|
${sampleRows}

## Disposition

This is a **sanity-check workload**, NOT a representative sample of real
\`claude_local\` agents. The busybox echo loop's resident set is on the order
of 1-3 MiB and CPU is near zero — it exercises the *measurement plumbing*
end-to-end, not the resource curve of any real agent runtime.

Real measurement against the live \`claude-code\` CLI is deferred to M3, when
the \`agent-runtime-claude\` image will be exercised against valid Anthropic
protocol. M1's defaults (256Mi requests / 1Gi limit, 200m / 2 CPU) are
retained until then.

Risk #4 in the M2 design spec is **partially resolved** by this report:
infrastructure ready, representative numbers pending real adapter.
`;
}
