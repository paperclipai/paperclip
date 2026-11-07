import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import {
  validSlackHumanConnect,
  validSlackHumanReceipt,
  type SlackHumanConnectInput,
  type SlackHumanConnectReceipt,
} from "./external-slack-human-contract.js";
/** This finite child performs one genuine named Slack human command. It neither
 * synthesizes a Slack event nor qualifies Paperclip's resulting connection. */
export async function privateSlackHumanConnect(
  input: Omit<SlackHumanConnectInput, "session"> & { sessionJson: string },
  privateSecrets: string[],
) {
  if (
    !input.sessionJson ||
    Buffer.byteLength(input.sessionJson) > 2 * 1024 * 1024
  )
    throw new Error(
      "Setup blocker: bounded private selected Slack human browser session is required",
    );
  let session: SlackHumanConnectInput["session"];
  try {
    session = JSON.parse(input.sessionJson);
  } catch {
    throw new Error(
      "Setup blocker: selected Slack browser state is not valid private JSON",
    );
  }
  privateSecrets.push(input.sessionJson);
  const request = {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    channelName: input.channelName,
    senderUserId: input.senderUserId,
    command: input.command,
    operation: input.operation,
    appId: input.appId,
    callbackURL: input.callbackURL,
    session,
  };
  if (!validSlackHumanConnect(request))
    throw new Error(
      "Setup blocker: selected private Slack session/command is outside the designated official human workspace contract",
    );
  for (const cookie of session?.cookies ?? [])
    if (typeof cookie.value === "string" && cookie.value)
      privateSecrets.push(cookie.value);
  for (const origin of session?.origins ?? [])
    for (const item of origin.localStorage ?? [])
      if (typeof item.value === "string" && item.value)
        privateSecrets.push(item.value);
  const directory = await mkdtemp(
    path.join(tmpdir(), "paperclip-slack-human-"),
  );
  try {
    const channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL,
      requestFile = path.join(directory, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        ...request,
        executablePath:
          process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ??
          (channel ? undefined : chromium.executablePath()),
        channel,
      }),
      { mode: 0o600 },
    );
    let output: string;
    try {
      output = (
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
              new URL("./external-slack-human-worker.ts", import.meta.url),
            ),
            requestFile,
          ],
          {
            timeout: 120000,
            maxBuffer: 8192,
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
        "Setup blocker: genuine Slack human browser session/control/member identity did not complete the finite connect command; private child diagnostics withheld",
      );
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(output);
    } catch {
      throw new Error("Slack human command returned an invalid closed receipt");
    }
    if (!validSlackHumanReceipt(receipt, request))
      throw new Error(
        "Slack human command did not prove the exact actual workspace/person",
      );
    return receipt as SlackHumanConnectReceipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
