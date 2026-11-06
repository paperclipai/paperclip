import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../../../server/src/home-paths.js";
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
    Array.isArray(receipt.catalogKeys) &&
    receipt.catalogKeys.length === 1 &&
    receipt.catalogKeys[0] === expected.boundKey &&
    Array.isArray(receipt.secretRefs) &&
    receipt.secretRefs.length === 1 &&
    receipt.secretRefs[0] === expected.boundSecretId &&
    receipt.companyKey === "unrelated-company-key" &&
    receipt.instanceKey === "custody_probe" &&
    receipt.companyDeniedStatus === 403 &&
    receipt.instanceDeniedStatus === 403 &&
    (expected.taskId === undefined || receipt.taskId === expected.taskId && receipt.taskWorkspaceMatched === true && typeof receipt.workspaceId === "string" && receipt.workspaceId.length > 0 && receipt.workspaceId === expected.workspaceId)
  );
}

export async function readSecretEndpointTaskBinding(ctx: ChatCatalogContext, agentId: string, runId: string, taskId: string, cwd: string) {
  const temporary = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!temporary || !taskId || !cwd || !ctx.issue()?.id) throw new Error("Actual secret consumer task context unavailable");
  const run = await ctx.input.api.get<{ id: string; companyId: string; agentId: string; status: string; startedAt: string | null; contextSnapshot: { issueId?: string } | null }>(`/api/heartbeat-runs/${runId}`, { timeout: 4000 });
  if (run.id !== runId || run.companyId !== ctx.input.fixtures.company.id || run.agentId !== agentId || run.status !== "running" || !run.startedAt || !Number.isFinite(Date.parse(run.startedAt)) || run.contextSnapshot?.issueId !== taskId)
    throw new Error("Secret consumer is not the actual active assigned run");
  const [task, view] = await Promise.all([
    ctx.input.api.get<{ id: string; companyId: string; assigneeAgentId: string | null; parentId: string | null; executionWorkspaceId: string | null }>(`/api/issues/${taskId}`, { timeout: 4000 }),
    ctx.input.api.get<{ workspace: { id: string; companyId: string; cwd: string } }>(`/api/issues/${taskId}/workspace`, { timeout: 4000 }),
  ]);
  if (task.id !== taskId || task.companyId !== run.companyId || task.assigneeAgentId !== agentId || task.parentId !== ctx.issue()!.id || !task.executionWorkspaceId || view.workspace.id !== task.executionWorkspaceId || view.workspace.companyId !== run.companyId)
    throw new Error("Secret consumer task workspace binding mismatch");
  const [owned, actual, reported] = await Promise.all([realpath(temporary), realpath(view.workspace.cwd), realpath(cwd)]);
  if (!actual.startsWith(owned + path.sep) || reported !== actual) throw new Error("Secret consumer is outside its actual owned task cwd");
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
  options?: { forbidAwsRuntimeAuthority?: true; taskBound?: true; personalWorkerReceipt?: true },
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
      (options?.personalWorkerReceipt || (record.agentId === agentId && /^[a-f0-9-]{36}$/i.test(record.runId))) &&
      record.method === "GET" &&
      record.pathname === "/publishing-check";
    if (options?.forbidAwsRuntimeAuthority)
      ok = ok && record.awsAuthorityAbsent === true;
    if (scopeProbe && ok) {
      const token = String(request.headers["x-paperclip-runtime"] ?? "");
      // Register before parsing, requests, exceptions or any parent diagnostics.
      if (token && token.length <= 8192) {
        ctx.input.privateSecrets?.push(token);
        privateRuntimeValues.add(token);
      }
      try {
        if (!token || token.length > 8192 || !ctx.input.privateSecrets)
          throw new Error("Private run credential unavailable");
        const claims = JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ) as { sub?: string; company_id?: string; run_id?: string };
        const tokenRunMatched =
          claims.sub === agentId &&
          claims.company_id === ctx.input.fixtures.company.id &&
          claims.run_id === record.runId;
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
        const taskBinding = options?.taskBound ? await readSecretEndpointTaskBinding(ctx, agentId, record.runId, String(request.headers["x-paperclip-task"] ?? ""), String(request.headers["x-paperclip-cwd"] ?? "")) : undefined;
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
  const script = `const credential=process.env[${JSON.stringify(envKey)}];if(!credential){process.stdout.write(JSON.stringify({ok:false,reason:'credential unavailable'}));process.exitCode=1;}else{try{const response=await fetch(${JSON.stringify(url)},{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+credential,...${options?.personalWorkerReceipt ? "{}" : "{'x-paperclip-agent':process.env.PAPERCLIP_AGENT_ID??'','x-paperclip-run':process.env.PAPERCLIP_RUN_ID??''}"},...${options?.taskBound ? "{'x-paperclip-task':process.env.PAPERCLIP_TASK_ID??'','x-paperclip-cwd':process.cwd()}" : "{}"},...${scopeProbe ? "{'x-paperclip-runtime':process.env.PAPERCLIP_API_KEY??''}" : "{}"},...${options?.forbidAwsRuntimeAuthority ? "{'x-paperclip-no-aws':String(!Object.keys(process.env).some(key=>key.startsWith('AWS_')||key.startsWith('PAPERCLIP_SECRETS_AWS_')))}" : "{}"}}});const result=await response.json();process.stdout.write(JSON.stringify({ok:result.ok===true,status:response.status,check:'publishing endpoint',...${options?.personalWorkerReceipt ? "(/^[a-f0-9]{48}$/.test(result.receiptId??''))?{receiptId:result.receiptId}:{}" : "{}"}}));if(!response.ok)process.exitCode=1;}catch{process.stdout.write(JSON.stringify({ok:false,reason:'endpoint check failed'}));process.exitCode=1;}}\n`;
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
