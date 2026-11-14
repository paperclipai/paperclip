import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import {
  validPublicSignInInput,
  publicSignInStorageMatches,
  type PublicSignInInput,
} from "./external-public-signin-contract.js";

export interface PublicSignInReceipt {
  processIsolation: true;
  testRunnerAttached: false;
  tracingEnabled: false;
  videoEnabled: false;
  apiStepRecorder: false;
  userId: string;
  signedIn: true;
  publicDomainOnly: true;
}
/** One generated fixture person signs in through the real supplied HTTPS front
 * door. Neither a loopback cookie nor a general navigation command is accepted. */
export async function privatePublicSignIn(
  input: PublicSignInInput,
  privateSecrets: string[],
  applyStorage: (privateFile: string) => Promise<void>,
): Promise<PublicSignInReceipt> {
  privateSecrets.push(input.password);
  if (!validPublicSignInInput(input))
    throw new Error("Invalid finite generated-person public sign-in request");
  const directory = await mkdtemp(
    path.join(tmpdir(), "paperclip-private-public-signin-"),
  );
  await chmod(directory, 0o700);
  try {
    const request = path.join(directory, "request.json"),
      storagePath = path.join(directory, "storage.json");
    const channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
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
    const worker = fileURLToPath(
      new URL("./external-public-signin-worker.ts", import.meta.url),
    );
    const loader = fileURLToPath(
      new URL(
        "../../../server/node_modules/tsx/dist/loader.mjs",
        import.meta.url,
      ),
    );
    let stdout: string;
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["--import", loader, worker, request],
        {
          timeout: 120000,
          maxBuffer: 16384,
          env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "test",
            DO_NOT_TRACK: "1",
            HOME: directory,
            TMPDIR: directory,
          },
        },
      );
      stdout = result.stdout;
    } catch {
      throw new Error(
        "Private public sign-in failed; child output and private handoff withheld",
      );
    }
    let storage: unknown;
    try {
      storage = JSON.parse(await readFile(storagePath, "utf8"));
    } catch {
      throw new Error("Private public sign-in storage handoff is unavailable");
    }
    // Register actual values before any parent validation or instrumented import.
    const raw = storage as {
      cookies?: Array<{ value?: unknown }>;
      origins?: Array<{ localStorage?: Array<{ value?: unknown }> }>;
    };
    for (const cookie of raw?.cookies ?? [])
      if (typeof cookie.value === "string") privateSecrets.push(cookie.value);
    for (const origin of raw?.origins ?? [])
      for (const item of origin.localStorage ?? [])
        if (typeof item.value === "string" && item.value)
          privateSecrets.push(item.value);
    if (!publicSignInStorageMatches(storage, input.publicOrigin))
      throw new Error("Public sign-in storage escaped its exact public domain");
    let receipt: PublicSignInReceipt;
    try {
      receipt = JSON.parse(stdout) as PublicSignInReceipt;
    } catch {
      throw new Error("Invalid closed public sign-in receipt");
    }
    if (
      Object.keys(receipt).sort().join(",") !==
        "apiStepRecorder,processIsolation,publicDomainOnly,signedIn,testRunnerAttached,tracingEnabled,userId,videoEnabled" ||
      receipt.processIsolation !== true ||
      receipt.testRunnerAttached !== false ||
      receipt.tracingEnabled !== false ||
      receipt.videoEnabled !== false ||
      receipt.apiStepRecorder !== false ||
      receipt.userId !== input.userId ||
      receipt.signedIn !== true ||
      receipt.publicDomainOnly !== true
    )
      throw new Error(
        "Public sign-in receipt failed its closed identity/isolation contract",
      );
    await applyStorage(storagePath);
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
