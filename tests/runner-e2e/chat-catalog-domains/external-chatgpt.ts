import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { signInPublicFixturePerson } from "../public-mcp-flow.js";
import {
  readValidatedPublicOriginReceipt,
  PUBLIC_ORIGIN_RECEIPT_ENV,
} from "../chat-public-origin.js";
import { selectedRuntimeInputs } from "./runtime-private.js";
import {
  validChatgptInput,
  validChatgptReceipt,
  type ChatgptInput,
  type ChatgptReceipt,
} from "./external-chatgpt-contract.js";
interface Custody {
  directory: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  exitCode: number | null | undefined;
  receipt?: ChatgptReceipt;
}
const owned = new WeakMap<ChatCatalogContext, Custody>();
export async function chatgptPublicOrigin(ctx: ChatCatalogContext) {
  const receiptPath = process.env[PUBLIC_ORIGIN_RECEIPT_ENV],
    attemptId = process.env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID;
  if (!receiptPath || !attemptId)
    throw new Error(
      "Setup blocker: actual named ChatGPT setup requires its selected owned HTTPS-origin receipt",
    );
  return readValidatedPublicOriginReceipt({
    receiptPath,
    attemptId,
    executionId: ctx.input.execution.id,
    backendOrigin: ctx.input.api.baseURL,
  });
}
async function inputFor(
  ctx: ChatCatalogContext,
  operation: ChatgptInput["operation"],
  control?: ChatgptInput["control"],
): Promise<ChatgptInput> {
  const selected = selectedRuntimeInputs(
      ctx,
      "assistant-connections.connect-external-assistant",
    ),
    p = selected.values,
    secrets = ctx.input.privateSecrets;
  if (
    !secrets ||
    p.operatorMode !== "interactive-private-ui" ||
    !selected.resourceIds.includes(p.chatgptAuthorizationRef)
  )
    throw new Error(
      "Setup blocker: explicitly selected available operator and authorized synthetic ChatGPT account reference are required; no ambient account/session is inferred",
    );
  secrets.push(p.operatorRef, p.chatgptAuthorizationRef);
  await signInPublicFixturePerson(ctx.input.api, ctx.input.page.context());
  const origin = await chatgptPublicOrigin(ctx),
    person = await ctx.input.api.get<{ user: { id: string } }>(
      "/api/auth/get-session",
    ),
    state = await ctx.input.page.context().storageState(),
    host = new URL(origin.publicOrigin).hostname;
  const publicSession = {
    cookies: state.cookies.filter((c) => c.domain.replace(/^\./, "") === host),
    origins: state.origins.filter((o) => o.origin === origin.publicOrigin),
  };
  for (const c of publicSession.cookies) secrets.push(c.value);
  for (const o of publicSession.origins)
    for (const item of o.localStorage) secrets.push(item.value);
  const channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
  const input: ChatgptInput = {
    operation,
    executionId: ctx.input.execution.id,
    attemptId: origin.attemptId,
    receiptPath: process.env[PUBLIC_ORIGIN_RECEIPT_ENV]!,
    backendOrigin: ctx.input.api.baseURL,
    publicOrigin: origin.publicOrigin,
    companyId: ctx.input.fixtures.company.id,
    companyName: ctx.input.fixtures.company.name,
    prefix: ctx.input.fixtures.company.issuePrefix ?? "",
    humanId: person.user.id,
    operatorRef: p.operatorRef,
    authorizationRef: p.chatgptAuthorizationRef,
    publicSession,
    control,
    executablePath:
      process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ??
      (channel ? undefined : chromium.executablePath()),
    channel,
  };
  if (!validChatgptInput(input))
    throw new Error(
      "Setup blocker: named ChatGPT operator/public-person/control contract is invalid",
    );
  return input;
}
async function stop(c: Custody) {
  if (c.exitCode === undefined) c.child.kill("SIGTERM");
  await Promise.race([c.exited, new Promise((r) => setTimeout(r, 5000))]);
  if (c.exitCode === undefined) c.child.kill("SIGKILL");
  await c.exited;
}
async function stage(c: Custody) {
  try {
    const value = JSON.parse(
      await readFile(path.join(c.directory, "stage.json"), "utf8"),
    ) as { stage?: string };
    return [
      "availability",
      "product-setup",
      "provider-app",
      "consent",
      "qualification",
      "awaiting-cleanup",
      "cleanup",
    ].includes(value.stage ?? "")
      ? value.stage
      : "unknown";
  } catch {
    return "unknown";
  }
}
async function start(ctx: ChatCatalogContext, input: ChatgptInput) {
  if (owned.has(ctx))
    throw new Error(
      "A named ChatGPT private child is already owned by this case",
    );
  const directory = await mkdtemp(
    path.join(tmpdir(), "paperclip-chatgpt-operator-"),
  );
  await chmod(directory, 0o700);
  try {
    const filename = path.join(directory, "request.json");
    await writeFile(filename, JSON.stringify(input), {
      mode: 0o600,
      flag: "wx",
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL(
            "../../../server/node_modules/tsx/dist/loader.mjs",
            import.meta.url,
          ),
        ),
        fileURLToPath(new URL("./external-chatgpt-worker.ts", import.meta.url)),
        filename,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          TMPDIR: directory,
          NODE_ENV: "test",
          DO_NOT_TRACK: "1",
        },
      },
    );
    let resolve!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolve = r;
    });
    const c: Custody = { directory, child, exited, exitCode: undefined };
    owned.set(ctx, c);
    child.once("error", () => {
      c.exitCode = 1;
      resolve(1);
    });
    child.once("exit", (code) => {
      c.exitCode = code;
      resolve(code);
    });
    const deadline =
      Date.now() + (input.operation === "availability" ? 45000 : 900000);
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(
          await readFile(path.join(directory, "qualified.json"), "utf8"),
        ) as ChatgptReceipt;
        if (!validChatgptReceipt(value, input))
          throw new Error(
            "Closed named ChatGPT receipt failed identity/isolation contract",
          );
        c.receipt = value;
        if (input.operation === "availability") {
          const code = await c.exited;
          if (code !== 0)
            throw new Error(
              "Named ChatGPT availability child did not close cleanly",
            );
          owned.delete(ctx);
          await rm(directory, { recursive: true, force: true });
        }
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (c.exitCode !== undefined)
        throw new Error(
          `Named ChatGPT human operation failed at ${await stage(c)}; private account/OAuth/browser diagnostics withheld`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Setup blocker: required named ChatGPT human operation exceeded its bounded ${await stage(c)} phase`,
    );
  } catch (error) {
    const c = owned.get(ctx);
    owned.delete(ctx);
    if (c) {
      // A failed private operation may still be removing its exact new app.
      // Allow only its finite existing cleanup phase before termination.
      if ((await stage(c)) === "cleanup")
        await Promise.race([
          c.exited,
          new Promise((r) => setTimeout(r, 125000)),
        ]);
      await stop(c);
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function privateChatgptAvailability(ctx: ChatCatalogContext) {
  return start(ctx, await inputFor(ctx, "availability"));
}
export async function privateChatgptSetup(
  ctx: ChatCatalogContext,
  control: NonNullable<ChatgptInput["control"]>,
) {
  return start(ctx, await inputFor(ctx, "setup", control));
}
/** Only this fixed cleanup gate is sent to the already-owned child; no generic
 * execute payload, provider token, browser state or arbitrary URL is accepted. */
export async function cleanupPrivateChatgpt(ctx: ChatCatalogContext) {
  const c = owned.get(ctx);
  owned.delete(ctx);
  if (!c) return;
  try {
    if (!c.receipt?.grantId)
      throw new Error(
        "Actual named ChatGPT setup never reached its closed qualification receipt",
      );
    await writeFile(
      path.join(c.directory, "cleanup.json"),
      JSON.stringify({
        operation: "cleanup",
        attemptId: c.receipt.attemptId,
        grantId: c.receipt.grantId,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const timeout = new Promise<"timeout">((r) => {
      const t = setTimeout(() => r("timeout"), 135000);
      t.unref();
    });
    const code = await Promise.race([c.exited, timeout]);
    if (code !== 0)
      throw new Error(
        "Named ChatGPT cleanup did not finish; selected operator must inspect the exact newly created test app",
      );
    const receipt = JSON.parse(
      await readFile(path.join(c.directory, "cleanup-complete.json"), "utf8"),
    ) as {
      attemptId: string;
      grantId: string;
      providerAppRemoved: boolean;
      privateBrowserClosed: boolean;
    };
    if (
      Object.keys(receipt).sort().join(",") !==
        "attemptId,grantId,privateBrowserClosed,providerAppRemoved" ||
      receipt.attemptId !== c.receipt.attemptId ||
      receipt.grantId !== c.receipt.grantId ||
      receipt.providerAppRemoved !== true ||
      receipt.privateBrowserClosed !== true
    )
      throw new Error(
        "Named ChatGPT cleanup lacks its exact closed actual UI deletion receipt",
      );
  } finally {
    await stop(c);
    await rm(c.directory, { recursive: true, force: true });
  }
}
