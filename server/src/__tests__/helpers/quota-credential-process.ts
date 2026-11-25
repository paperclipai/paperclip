// A real receiver process for the credential-loss boundary test. No provider
// credentials leave this process through logs, IPC, or diagnostic exceptions.
import { createDb } from "@paperclipai/db";
import { once } from "node:events";
import { aiConnectionService } from "../../services/ai-connections.js";

const db = createDb(process.env.CREDENTIAL_TEST_DATABASE_URL!);
let provider: string;
const request = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected fixture network request");
  return request(provider, init);
};
try {
  const service = aiConnectionService(db);
  // Loading the real service graph belongs to fixture startup, before the
  // parent starts the deadline for the exchange/save boundary itself.
  if (!process.send) throw new Error("Fixture requires an IPC channel");
  const command = once(process, "message");
  process.send({ type: "ready" });
  const [message] = await command;
  if (message?.type !== "refresh" || typeof message.providerUrl !== "string") throw new Error("Unexpected fixture command");
  const url = new URL(message.providerUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Unexpected fixture provider");
  provider = url.href;
  const [row] = await service.quotaAccounts(process.env.CREDENTIAL_TEST_COMPANY_ID!, process.env.CREDENTIAL_TEST_OWNER!);
  await service.refreshQuotaCredential(row, await service.credential(row), new AbortController().signal);
  process.exitCode = 0;
} catch { process.exitCode = 1; }
finally {
  await db.$client.end();
  if (process.connected) process.disconnect();
}
