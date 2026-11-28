import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../../../server/src/home-paths.js";
import { createLocalAgentJwt } from "../../../server/src/agent-auth-jwt.js";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import {
  bytesContainSecret,
  scanReachableSecretOutputs,
} from "./external-secret-scan.js";
export interface SecretScopeProbe {
  boundSecretId: string;
  unrelatedCompanyKey: string;
  instanceKey: "custody_probe";
}
export interface SecretScopeReceipt {
  runId: string;
  agentId: string;
  companyId: string;
  tokenRunMatched: boolean;
  identityStatus: number;
  catalogStatus: number;
  catalogKeys: string[];
  secretRefs: string[];
  companyKey: string;
  instanceKey: string;
  companyDeniedStatus: number;
  instanceDeniedStatus: number;
  taskId?: string;
  workspaceId?: string;
  taskWorkspaceMatched?: boolean;
}
export function validSecretScopeReceipt(
  value: unknown,
  expected: {
    runId: string;
    agentId: string;
    companyId: string;
    boundSecretId: string;
    boundKey: string;
    taskId?: string;
    workspaceId?: string;
  },
) {
  const receipt = value as Partial<SecretScopeReceipt> | undefined;
  return (
    !!receipt &&
    receipt.runId === expected.runId &&
    receipt.agentId === expected.agentId &&
    receipt.companyId === expected.companyId &&
    receipt.tokenRunMatched === true &&
    receipt.identityStatus === 200 &&
    receipt.catalogStatus === 200 &&
    // The worker's catalog also lists its model-provider credential binding;
    // the bound key must appear exactly once, by the bound secret, and neither
    // probed key may appear.
    Array.isArray(receipt.catalogKeys) &&
    Array.isArray(receipt.secretRefs) &&
    receipt.catalogKeys.length === receipt.secretRefs.length &&
    receipt.catalogKeys.filter(key => key === expected.boundKey).length === 1 &&
    receipt.secretRefs[receipt.catalogKeys.indexOf(expected.boundKey)] === expected.boundSecretId &&
    !receipt.catalogKeys.includes("unrelated-company-key") &&
    !receipt.catalogKeys.includes("custody_probe") &&
    receipt.companyKey === "unrelated-company-key" &&
    receipt.instanceKey === "custody_probe" &&
    receipt.companyDeniedStatus === 403 &&
    receipt.instanceDeniedStatus === 403 &&
    (expected.taskId === undefined || receipt.taskId === expected.taskId && receipt.taskWorkspaceMatched === true && typeof receipt.workspaceId === "string" && receipt.workspaceId.length > 0 && receipt.workspaceId === expected.workspaceId)
  );
}

/** Native runner shells carry no Paperclip run identity (PAPERCLIP_API_KEY,
 * PAPERCLIP_AGENT_ID and PAPERCLIP_RUN_ID are reserved), so the consumer is
 * identified from saved server state when the bound credential arrives: the
 * agent's one running run, on a task it owns, created from this chat, with its
 * own execution workspace inside the attempt root. Nothing here depends on
 * what the model copied into the command. */
export async function readSecretEndpointConsumerRun(ctx: ChatCatalogContext, agentId: string) {
  const run = await readSecretEndpointActiveRun(ctx, agentId);
  return { run, ...(await readSecretEndpointTaskBinding(ctx, agentId, run.id, String(run.contextSnapshot?.issueId ?? ""))) };
}

/** The agent's one running run in this company, read from the server. */
export async function readSecretEndpointActiveRun(ctx: ChatCatalogContext, agentId: string) {
  const companyId = ctx.input.fixtures.company.id;
  const rows = await ctx.input.api.get<Array<{ id: string; agentId: string; status: string }>>(`/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=20`, { timeout: 4000 });
  const running = rows.filter(row => row.agentId === agentId && row.status === "running");
  if (running.length !== 1) throw new Error("Secret consumer has no single active run");
  const run = await ctx.input.api.get<{ id: string; companyId: string; agentId: string; status: string; startedAt: string | null; responsibleUserId?: string | null; contextSnapshot: { issueId?: string } | null }>(`/api/heartbeat-runs/${running[0]!.id}`, { timeout: 4000 });
  if (run.id !== running[0]!.id || run.companyId !== companyId || run.agentId !== agentId || run.status !== "running")
    throw new Error("Secret consumer is not the actual active run");
  return run;
}

export async function readSecretEndpointTaskBinding(ctx: ChatCatalogContext, agentId: string, runId: string, taskId: string) {
  const temporary = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!temporary || !taskId || !ctx.issue()?.id) throw new Error("Actual secret consumer task context unavailable");
  const run = await ctx.input.api.get<{ id: string; companyId: string; agentId: string; status: string; startedAt: string | null; contextSnapshot: { issueId?: string } | null }>(`/api/heartbeat-runs/${runId}`, { timeout: 4000 });
  if (run.id !== runId || run.companyId !== ctx.input.fixtures.company.id || run.agentId !== agentId || run.status !== "running" || !run.startedAt || !Number.isFinite(Date.parse(run.startedAt)) || run.contextSnapshot?.issueId !== taskId)
    throw new Error("Secret consumer is not the actual active assigned run");
  const [task, view] = await Promise.all([
    ctx.input.api.get<{ id: string; companyId: string; assigneeAgentId: string | null; originIssueId?: string | null; executionWorkspaceId: string | null }>(`/api/issues/${taskId}`, { timeout: 4000 }),
    ctx.input.api.get<{ workspace: { id: string; companyId: string; cwd: string } }>(`/api/issues/${taskId}/workspace`, { timeout: 4000 }),
  ]);
  if (task.id !== taskId || task.companyId !== run.companyId || task.assigneeAgentId !== agentId || task.originIssueId !== ctx.issue()!.id || !task.executionWorkspaceId || view.workspace.id !== task.executionWorkspaceId || view.workspace.companyId !== run.companyId)
    throw new Error("Secret consumer task workspace binding mismatch");
  const [owned, actual] = await Promise.all([realpath(temporary), realpath(view.workspace.cwd)]);
  if (!actual.startsWith(owned + path.sep)) throw new Error("Secret consumer task workspace is outside the attempt root");
  return { taskId: task.id, workspaceId: view.workspace.id, taskWorkspaceMatched: true as const };
}

/** Owned loopback publishing check. Credential bytes stay in the server closure;
 * the task receives only a script path and sanitized result. */
export async function secretTestEndpoint(
  ctx: ChatCatalogContext,
  agentId: string,
  value: string,
  envKey: "PUBLISHING_API_KEY" | "DEPLOYMENT_API_KEY",
  scopeProbe?: SecretScopeProbe,
  options?: { forbidAwsRuntimeAuthority?: true; taskBound?: true; personalWorkerReceipt?: true; activeRunConsumer?: true },
) {
  if (options?.personalWorkerReceipt && (ctx.scenario.id !== "secrets.personal-secret" || envKey !== "PUBLISHING_API_KEY" || scopeProbe || options.taskBound || options.forbidAwsRuntimeAuthority)) throw new Error("Personal worker receipts require the dedicated personal-secret endpoint");
  if (ctx.input.execution.environment.id !== "local")
    throw new Error(
      "Setup blocker: controlled secret endpoint needs the actual local worker environment",
    );
  const temporary = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!temporary)
    throw new Error("Secret endpoint requires its isolated attempt root");
  const root = await realpath(temporary);
  let home: string | undefined;
  if (options?.taskBound) {
    if (ctx.scenario.id !== "secrets.least-scope-delivery" || !scopeProbe) throw new Error("Task-bound secret helper is restricted to the scoped delivery fixture");
  } else {
    const candidate = path.resolve(resolveDefaultAgentWorkspaceDir(agentId));
    if (!candidate.startsWith(root + path.sep)) throw new Error("Secret endpoint worker workspace escaped the disposable root");
    await mkdir(candidate, { recursive: true });
    home = await realpath(candidate);
    if (!home.startsWith(root + path.sep)) throw new Error("Secret endpoint worker path resolved outside the disposable root");
  }
  const calls: Array<{
    authorized: boolean;
    agentId: string;
    runId: string;
    method: string;
    pathname: string;
    awsAuthorityAbsent?: boolean;
    receiptId?: string;
    createdAt?: string;
    status?: number;
  }> = [];
  const scopeReceipts: SecretScopeReceipt[] = [],
    privateRuntimeValues = new Set<string>();
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${value}`;
    const record: (typeof calls)[number] = {
      authorized,
      agentId: String(request.headers["x-paperclip-agent"] ?? ""),
      runId: String(request.headers["x-paperclip-run"] ?? ""),
      method: request.method ?? "",
      pathname: request.url ?? "",
      ...(options?.forbidAwsRuntimeAuthority
        ? {
            awsAuthorityAbsent:
              request.headers["x-paperclip-no-aws"] === "true",
          }
        : {}),
    };
    if (calls.length >= 8) {
      response.writeHead(429);
      response.end();
      return;
    }
    calls.push(record);
    let ok =
      authorized &&
      (options?.personalWorkerReceipt || options?.taskBound || options?.activeRunConsumer || (record.agentId === agentId && /^[a-f0-9-]{36}$/i.test(record.runId))) &&
      record.method === "GET" &&
      record.pathname === "/publishing-check";
    if (options?.activeRunConsumer && ok) {
      // Native runner shells carry no Paperclip run identity; attribute the
      // call to the agent's one running run from saved server state.
      try {
        const run = await readSecretEndpointActiveRun(ctx, agentId);
        record.agentId = run.agentId;
        record.runId = run.id;
      } catch {
        ok = false;
      }
    }
    if (options?.forbidAwsRuntimeAuthority)
      ok = ok && record.awsAuthorityAbsent === true;
    if (scopeProbe && ok) {
      try {
        if (!ctx.input.privateSecrets) throw new Error("Private run credential unavailable");
        // The consumer is the agent's actual running run, read from the server.
        const consumer = await readSecretEndpointConsumerRun(ctx, agentId),
          actor = await ctx.input.api.get<{ id: string; companyId: string; adapterType: string }>(`/api/agents/${agentId}`, { timeout: 4000 });
        record.runId = consumer.run.id;
        // Probe with the same run-bound agent authority the native tool bridge
        // mints for this run (createLocalAgentJwt), never a fixture identity.
        const token = createLocalAgentJwt(agentId, ctx.input.fixtures.company.id, actor.adapterType, consumer.run.id, consumer.run.responsibleUserId ?? null) ?? "";
        // Register before parsing, requests, exceptions or any parent diagnostics.
        if (token && token.length <= 8192) {
          ctx.input.privateSecrets.push(token);
          privateRuntimeValues.add(token);
        }
        if (!token || token.length > 8192) throw new Error("Private run credential unavailable");
        const claims = JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ) as { sub?: string; company_id?: string; run_id?: string };
        const tokenRunMatched =
          actor.id === agentId &&
          actor.companyId === ctx.input.fixtures.company.id &&
          claims.sub === agentId &&
          claims.company_id === ctx.input.fixtures.company.id &&
          claims.run_id === consumer.run.id;
        if (!tokenRunMatched)
          throw new Error("Run credential identity mismatch");
        const call = (pathname: string, method = "GET") =>
          fetch(new URL(pathname, ctx.input.api.baseURL), {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(4000),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
        const [identity, catalog] = await Promise.all([
          call("/api/agents/me"),
          call("/api/agents/me/secrets"),
        ]);
        const identityStatus = identity.status,
          catalogStatus = catalog.status;
        const who = identity.ok
          ? ((await identity.json()) as { id: string; companyId: string })
          : undefined;
        if (!identity.ok) await identity.body?.cancel();
        const listed = catalog.ok
          ? ((await catalog.json()) as {
              secrets: Array<{ key: string; secretRef: string }>;
            })
          : undefined;
        if (!catalog.ok) await catalog.body?.cancel();
        if (
          who?.id !== agentId ||
          who.companyId !== ctx.input.fixtures.company.id ||
          !Array.isArray(listed?.secrets) ||
          listed.secrets.length > 20
        )
          throw new Error("Scoped run authority could not be verified");
        const taskBinding = options?.taskBound ? { taskId: consumer.taskId, workspaceId: consumer.workspaceId, taskWorkspaceMatched: consumer.taskWorkspaceMatched } : undefined;
        const denied = await Promise.all(
          [scopeProbe.unrelatedCompanyKey, scopeProbe.instanceKey].map((key) =>
            call(
              `/api/agents/me/secrets/${encodeURIComponent(key)}/value`,
              "POST",
            ),
          ),
        );
        const receipt: SecretScopeReceipt = {
          ...taskBinding,
          runId: record.runId,
          agentId,
          companyId: who.companyId,
          tokenRunMatched,
          identityStatus,
          catalogStatus,
          catalogKeys: listed.secrets.map((row) => row.key),
          secretRefs: listed.secrets.map((row) => row.secretRef),
          companyKey: scopeProbe.unrelatedCompanyKey,
          instanceKey: scopeProbe.instanceKey,
          companyDeniedStatus: denied[0]!.status,
          instanceDeniedStatus: denied[1]!.status,
        };
        await Promise.all(denied.map((result) => result.body?.cancel()));
        scopeReceipts.push(receipt);
        ok = validSecretScopeReceipt(receipt, {
          ...taskBinding,
          runId: record.runId,
          agentId,
          companyId: ctx.input.fixtures.company.id,
          boundSecretId: scopeProbe.boundSecretId,
          boundKey: "deployment-api-key",
          ...(taskBinding ? { taskId: taskBinding.taskId, workspaceId: taskBinding.workspaceId } : {}),
        });
      } catch {
        ok = false;
      }
    }
    if (options?.personalWorkerReceipt) {
      record.createdAt = new Date().toISOString(); record.status = ok ? 200 : 403;
      if (ok) record.receiptId = randomBytes(24).toString("hex");
    }
    response.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok,
        check: "publishing endpoint",
        status: ok ? 200 : 403,
        ...(record.receiptId ? { receiptId: record.receiptId } : {}),
      }),
    );
  });
  const port = await listenOnFetchAllowedPort(server),
    scriptPath = home ? path.join(home, `secret-endpoint-check-${ctx.input.nonce}.mjs`) : "",
    url = `http://127.0.0.1:${port}/publishing-check`;
  const script = `const credential=process.env[${JSON.stringify(envKey)}];if(!credential){process.stdout.write(JSON.stringify({ok:false,reason:'credential unavailable'}));process.exitCode=1;}else{try{const response=await fetch(${JSON.stringify(url)},{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+credential${options?.personalWorkerReceipt || options?.taskBound || options?.activeRunConsumer ? "" : ",...{'x-paperclip-agent':process.env.PAPERCLIP_AGENT_ID??'','x-paperclip-run':process.env.PAPERCLIP_RUN_ID??''}"},...${options?.forbidAwsRuntimeAuthority ? "{'x-paperclip-no-aws':String(!Object.keys(process.env).some(key=>key.startsWith('AWS_')||key.startsWith('PAPERCLIP_SECRETS_AWS_')))}" : "{}"}}});const result=await response.json();process.stdout.write(JSON.stringify({ok:result.ok===true,status:response.status,check:'publishing endpoint',...${options?.personalWorkerReceipt ? "(/^[a-f0-9]{48}$/.test(result.receiptId??''))?{receiptId:result.receiptId}:{}" : "{}"}}));if(!response.ok)process.exitCode=1;}catch{process.stdout.write(JSON.stringify({ok:false,reason:'endpoint check failed'}));process.exitCode=1;}}\n`;
  if (scriptPath) await writeFile(scriptPath, script, { mode: 0o600 });
  const command = scriptPath ? `node ${JSON.stringify(scriptPath)}` : `node --input-type=module -e '${script.replace(/'/g, "'\\''")}'`;
  return {
    url,
    scriptPath,
    command,
    calls,
    scopeReceipts,
    async scanPrivateRuntimeOutputs(issueIds: string[], raw: unknown) {
      let complete = scopeProbe ? privateRuntimeValues.size === 1 : true,
        leaked = false;
      const bytes = Buffer.from(JSON.stringify(raw));
      for (const token of privateRuntimeValues) {
        const scan = await scanReachableSecretOutputs(ctx, issueIds, token);
        complete = complete && scan.complete;
        leaked = leaked || scan.leaked || bytesContainSecret(bytes, token);
      }
      return { complete, leaked };
    },
    async close() {
      try {
        if (scriptPath) await rm(scriptPath, { force: true });
      } finally {
        privateRuntimeValues.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
