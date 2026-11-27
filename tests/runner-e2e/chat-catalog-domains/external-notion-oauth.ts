import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { signInPublicFixturePerson } from "../public-mcp-flow.js";
import {
  readValidatedPublicOriginReceipt,
  PUBLIC_ORIGIN_RECEIPT_ENV,
} from "../chat-public-origin.js";
import {
  selectedExternalBinding,
  selectedExternalCredential,
} from "./external-fixtures.js";
import {
  validNotionOAuthInput,
  validNotionOAuthReceipt,
  type NotionOAuthInput,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
/** Selected actual human/provider session only; no generic navigation or private
 * credential injection into the instrumented Test browser. */
export async function privateNotionOAuth(
  ctx: ChatCatalogContext,
  options: Pick<
    NotionOAuthInput,
    "operation" | "intentId" | "draftId" | "reconnectId"
  >,
) {
  const binding = selectedExternalBinding(ctx),
    p = binding.prerequisites;
  const secrets = ctx.input.privateSecrets;
  if (!secrets)
    throw new Error(
      "Private Notion OAuth requires the owning attempt redaction sink",
    );
  const sessionJson = selectedExternalCredential(
    ctx,
    binding,
    "oauthBrowserSessionEnv",
  );
  const providerEmail = selectedExternalCredential(
    ctx,
    binding,
    "oauthHumanEmailEnv",
  );
  secrets.push(sessionJson, providerEmail);
  if (Buffer.byteLength(sessionJson) > 2 * 1024 * 1024)
    throw new Error(
      "Setup blocker: bounded selected Notion human session is required",
    );
  let notionSession: NotionOAuthInput["notionSession"];
  try {
    notionSession = JSON.parse(sessionJson);
  } catch {
    throw new Error(
      "Setup blocker: selected private Notion human session JSON is invalid",
    );
  }
  for (const cookie of notionSession?.cookies ?? [])
    if (typeof cookie.value === "string") secrets.push(cookie.value);
  for (const origin of notionSession?.origins ?? [])
    for (const item of origin.localStorage ?? [])
      if (typeof item.value === "string" && item.value)
        secrets.push(item.value);
  await signInPublicFixturePerson(ctx.input.api, ctx.input.page.context());
  const receiptPath = process.env[PUBLIC_ORIGIN_RECEIPT_ENV],
    attemptId = process.env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID;
  const executions = JSON.parse(
    process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "[]",
  ) as string[];
  if (!receiptPath || !attemptId || executions.length !== 1)
    throw new Error(
      "Setup blocker: selected Notion attempt requires its owned validated public origin",
    );
  const origin = await readValidatedPublicOriginReceipt({
    receiptPath,
    attemptId,
    executionId: executions[0]!,
    backendOrigin: ctx.input.api.baseURL,
  });
  const publicStorage = await ctx.input.page.context().storageState();
  const host = new URL(origin.publicOrigin).hostname;
  const publicSession = {
    cookies: publicStorage.cookies.filter(
      (c) => c.domain.replace(/^\./, "") === host,
    ),
    origins: publicStorage.origins.filter(
      (o) => o.origin === origin.publicOrigin,
    ),
  };
  const human = await ctx.input.api.get<{ user: { id: string } }>(
    "/api/auth/get-session",
  );
  const input: NotionOAuthInput = {
    ...options,
    ...(ctx.scenario.id === "connection-setup.notion-wrong-account"
      ? { newPersonal: true as const }
      : {}),
    ...(options.intentId ? { issueId: ctx.issue()?.id } : {}),
    publicOrigin: origin.publicOrigin,
    companyId: ctx.input.fixtures.company.id,
    prefix: ctx.input.fixtures.company.issuePrefix ?? "",
    humanId: human.user.id,
    agentId: ctx.input.fixtures.agent.id,
    workspaceId: p.workspaceId!,
    workspaceName: p.workspaceName!,
    providerEmail,
    notionSession,
    publicSession,
  };
  if (!validNotionOAuthInput(input))
    throw new Error(
      "Setup blocker: Notion human/workspace/session prerequisite is outside the finite named-provider contract",
    );
  const directory = await mkdtemp(
    path.join(tmpdir(), "paperclip-notion-oauth-"),
  );
  await chmod(directory, 0o700);
  try {
    const request = path.join(directory, "request.json"),
      channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
    await writeFile(
      request,
      JSON.stringify({
        ...input,
        executablePath:
          process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ??
          (channel ? undefined : chromium.executablePath()),
        channel,
      }),
      { mode: 0o600 },
    );
    let stdout: string;
    try {
      stdout = (
        await promisify(execFile)(
          process.execPath,
          [
            "--import",
            fileURLToPath(
              new URL(
                "../../../server/node_modules/tsx/dist/loader.mjs",
                import.meta.url,
              ),
            ),
            fileURLToPath(
              new URL("./external-notion-oauth-worker.ts", import.meta.url),
            ),
            request,
          ],
          {
            timeout: 240000,
            maxBuffer: 16384,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: directory,
              TMPDIR: directory,
              NODE_ENV: "test",
              DO_NOT_TRACK: "1",
            },
          },
        )
      ).stdout;
    } catch {
      throw new Error(
        "Private named Notion setup failed; session/provider/redirect details withheld",
      );
    }
    let receipt: NotionOAuthReceipt;
    try {
      receipt = JSON.parse(stdout);
    } catch {
      throw new Error("Private Notion setup did not return its closed receipt");
    }
    if (!validNotionOAuthReceipt(receipt, input))
      throw new Error(
        "Private Notion setup receipt failed its exact identity/draft/isolation contract",
      );
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
