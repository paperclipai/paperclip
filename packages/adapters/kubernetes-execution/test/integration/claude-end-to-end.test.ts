import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";
import { mapTerminalState } from "../../src/orchestrator/failure-mapping.js";
import { startLogStream } from "../../src/orchestrator/log-stream.js";
import {
  applyAgentWorkspacePvc,
  buildAgentWorkspacePvc,
} from "../../src/orchestrator/pvc.js";
import {
  applyEphemeralSecret,
  buildEphemeralSecret,
  patchEphemeralSecretOwnerReference,
} from "../../src/orchestrator/secret.js";
import type { KubernetesApiClient } from "../../src/types.js";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { buildBusyboxTestJob } from "./_helpers/busybox-job.js";
import {
  startFakeAnthropic,
  type FakeAnthropic,
} from "./_helpers/fake-anthropic.js";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * M2 Task 26: end-to-end integration test for the claude_local execution
 * path on a real kind cluster.
 *
 * Scope reduction (documented intentionally):
 *
 *   This test does NOT exercise the real `@anthropic-ai/claude-code` CLI nor
 *   the `paperclipai/agent-runtime-claude` image. Both are too heavy/coupled
 *   to integrate cleanly here:
 *     - claude-code expects a structurally valid Anthropic protocol response
 *       and a working API key flow.
 *     - The runtime image's workspace-init runs first and would need the
 *       paperclip control-plane reachable from the pod (via PAPERCLIP_PUBLIC_URL
 *       pointing at host.docker.internal) plus a real bootstrap token exchange.
 *
 *   Building all of that just for this test would balloon scope without
 *   strengthening the M2 acceptance criteria. Real claude-code integration is
 *   deferred to a Task 26.5 / M3 follow-up.
 *
 * What this test PROVES:
 *   - The FULL Job lifecycle on kind: PVC + Secret + Job, scheduled, runs,
 *     terminates, log stream surfaces stdout, mapTerminalState reports success.
 *   - The agent container can reach an HTTP server running on the host via
 *     `host.docker.internal` (the wiring claude-local needs for ANTHROPIC_BASE_URL
 *     overrides during tests/dev).
 *   - The fake-agent's POST round-trip to `/v1/messages` works end-to-end.
 *
 * What this test does NOT exercise (and where it IS covered):
 *   - The real claude-code CLI: deferred to Task 26.5 / M3.
 *   - The agent-shim → workspace-init → exchange flow: covered by unit tests
 *     on `buildAgentJob()` and the bootstrap-token service.
 *   - The `KubernetesExecutionDriver.run()` orchestration: covered by
 *     `driver-run.test.ts` (unit) and exercised here by re-using the same
 *     orchestrator helpers (ensureTenantNamespace, applyEphemeralSecret,
 *     applyAgentWorkspacePvc, startLogStream, mapTerminalState).
 *
 * Networking caveat:
 *   The fake server runs on the host; the agent pod reaches it via
 *   `host.docker.internal`. On Docker Desktop (macOS/Windows) this resolves
 *   automatically. On Linux CI (GitHub Actions runners), kind needs an
 *   explicit `extraPortMappings` + `--add-host=host.docker.internal:host-gateway`
 *   in the cluster config. If this test fails on Linux with a DNS error, that
 *   is the fix; we do not currently encode it because all M2 contributors run
 *   Docker Desktop locally.
 */

const COMPANY_ID = "55555555-5555-5555-5555-555555555555";
const COMPANY_SLUG = "claudeend";
const AGENT_SLUG = "claudeend-agent";
const RUN_ULID = "01testclaudeend000000000001";
const FAKE_AGENT_TAG = "paperclipai/fake-agent:test-m2";

interface PollOpts {
  intervalMs?: number;
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  deadlineMs: number,
  opts: PollOpts = {},
): Promise<T | undefined> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return undefined;
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

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "claude-style agent end-to-end on kind (fake LLM, fake agent)",
  () => {
    let kind: KindCluster;
    let fake: FakeAnthropic;
    let client: KubernetesApiClient;
    let connection: ResolvedClusterConnection;
    let agentImage: string;

    beforeAll(async () => {
      kind = spinUpKind();
      fake = await startFakeAnthropic();

      // Build + load the fake-agent image into kind, unless an override was
      // provided (CI can pre-build to skip the ~10s build cost on warm
      // Docker layer cache).
      const override = process.env["AGENT_CLAUDE_IMAGE"];
      if (override) {
        agentImage = override;
        // eslint-disable-next-line no-console
        console.log(`[claude-end-to-end] using pre-built image override: ${agentImage}`);
      } else {
        agentImage = FAKE_AGENT_TAG;
        const helpersDir = path.resolve(__dirname, "_helpers");
        // eslint-disable-next-line no-console
        console.log(`[claude-end-to-end] building ${agentImage} from ${helpersDir}/fake-agent.Dockerfile`);
        await exec(
          "docker",
          [
            "build",
            "-t",
            agentImage,
            "-f",
            path.join(helpersDir, "fake-agent.Dockerfile"),
            helpersDir,
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        // eslint-disable-next-line no-console
        console.log(`[claude-end-to-end] loading ${agentImage} into kind cluster ${kind.name}`);
        await exec(
          "kind",
          ["load", "docker-image", agentImage, "--name", kind.name],
          { maxBuffer: 16 * 1024 * 1024 },
        );
      }

      connection = {
        id: "c-1",
        label: "kind",
        kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64", "arm64"] },
      };
      client = createKubernetesApiClient(connection);
    }, 300_000);

    afterAll(async () => {
      await fake?.stop();
      kind?.cleanup();
    });

    it(
      "runs the fake agent against the fake Anthropic and surfaces the assistant text in pod logs",
      async () => {
        // 1. Tenant namespace.
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
          adapterAllowFqdns: [],
          imagePullDockerConfigJson: null,
        });
        const namespace = ensureResult.namespace;
        // Always-hash namespace shape: paperclip-<slug>-<8-char-hash(companyId)>.
        // See M3b Task 17 / orchestrator/naming.ts for the rationale.
        expect(namespace).toMatch(new RegExp(`^paperclip-${COMPANY_SLUG}-[0-9a-z]{8}$`));

        // 2. Workspace PVC. We don't actually write to /workspace, but the
        //    Job spec mounts one and the failure-modes/job-lifecycle helpers
        //    insist on a PVC name. Reuse the same builder for parity.
        const pvc = buildAgentWorkspacePvc({
          namespace,
          agentId: "66666666-6666-6666-6666-666666666666",
          agentSlug: AGENT_SLUG,
          companyId: COMPANY_ID,
          companySlug: COMPANY_SLUG,
          storageClass: "standard",
          sizeGi: 1,
          strategyKey: "none",
        });
        await applyAgentWorkspacePvc(client, pvc);

        // 3. Ephemeral Secret carrying ANTHROPIC_BASE_URL pointing at the
        //    host's fake server. This is the variable the fake-agent script
        //    reads. We use a placeholder OwnerReference and patch it after
        //    Job creation (same two-phase commit as the driver).
        const secret = buildEphemeralSecret({
          namespace,
          agentSlug: AGENT_SLUG,
          runUlid: RUN_ULID,
          runId: `test-run-${RUN_ULID}`,
          companyId: COMPANY_ID,
          companySlug: COMPANY_SLUG,
          data: {
            ANTHROPIC_BASE_URL: fake.url,
            // The real driver injects BOOTSTRAP_TOKEN via this same envFrom
            // path. We include a placeholder so the env shape mirrors prod
            // even though our fake-agent ignores it.
            BOOTSTRAP_TOKEN: "bst_test_unused",
          },
          ownerJob: {
            name: "placeholder",
            uid: "00000000-0000-0000-0000-000000000000",
          },
        });
        const secretName = secret.metadata!.name!;
        secret.metadata!.ownerReferences = [];
        await applyEphemeralSecret(client, secret);

        // 4. Job. We re-use buildBusyboxTestJob with an image override so we
        //    inherit the PSS Restricted security context, volume layout, and
        //    envFrom plumbing from the existing tested helper.
        const jobName = `agent-${AGENT_SLUG}-run-${RUN_ULID}`;
        const jobSpec = buildBusyboxTestJob({
          namespace,
          jobName,
          pvcName: pvc.metadata!.name!,
          envSecretName: secretName,
          image: agentImage,
          // The fake-agent image's ENTRYPOINT runs the script, but
          // buildBusyboxTestJob hard-codes `command: ["sh", "-c", agentScript]`
          // so we explicitly invoke the binary. /usr/local/bin is on busybox's
          // default PATH; using the absolute path is robust against any PATH
          // surprise from the security context.
          agentScript: "/usr/local/bin/paperclip-agent-shim",
          activeDeadlineSeconds: 60,
        });
        const created = await client.batch.createNamespacedJob(namespace, jobSpec);
        const jobUid = created.body.metadata!.uid!;
        expect(jobUid).toBeTruthy();

        await patchEphemeralSecretOwnerReference(client, namespace, secretName, {
          name: jobName,
          uid: jobUid,
        });

        // 5. Wait for the agent container to enter Running or Terminated, then
        //    attach the log stream. (See job-lifecycle.test.ts for why we don't
        //    open the stream against a Pending pod.)
        const podName = await pollUntil<string>(async () => {
          const p = await findPod(client, namespace, jobName);
          const c = p?.status?.containerStatuses?.find((s) => s.name === "agent");
          if (p?.metadata?.name && (c?.state?.running || c?.state?.terminated)) {
            return p.metadata.name;
          }
          return undefined;
        }, 90_000, { intervalMs: 500 });
        expect(podName, "expected agent container to start within 90s").toBeTruthy();

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

        // 6. Poll for terminal Job state.
        let terminalJob: V1Job | undefined;
        let terminalPod: V1Pod | undefined;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const j = await client.batch.readNamespacedJob(jobName, namespace);
          if ((j.body.status?.succeeded ?? 0) >= 1 || (j.body.status?.failed ?? 0) >= 1) {
            terminalJob = j.body;
            terminalPod = await findPod(client, namespace, jobName);
            break;
          }
        }
        logHandle.abort();
        await logHandle.done;

        // Diagnostics dump on failure paths so platform-specific networking
        // skew is visible in CI logs.
        const joinedLogs = logs.join("\n");
        if (!terminalJob) {
          // eslint-disable-next-line no-console
          console.warn("[claude-end-to-end] no terminal Job state. logs so far:\n" + joinedLogs);
        }
        expect(terminalJob, "expected Job to reach terminal state within 120s").toBeTruthy();

        const result = mapTerminalState({ job: terminalJob!, pod: terminalPod });
        if (result.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn(
            "[claude-end-to-end] non-zero exit. mapped result:",
            result,
            "\nlogs:\n" + joinedLogs,
          );
        }
        expect(result.exitCode).toBe(0);
        expect(result.errorCode).toBeUndefined();
        expect(result.timedOut).toBe(false);

        // 7. The assistant text from the fake server must show up in the
        //    container's stdout — proving the round-trip:
        //    pod  →  host.docker.internal:port/v1/messages  →  fake server
        //         ←  JSON with {"text":"I read your prompt and I am alive."}  ←
        expect(joinedLogs).toMatch(/I read your prompt and I am alive/);
        // And the fake-agent's own progress markers, so we know the script
        // actually executed (not just a stale cached log).
        expect(joinedLogs).toContain("[fake-agent] starting");
        expect(joinedLogs).toContain("[fake-agent] success: assistant marker found");
      },
      300_000,
    );
  },
);
