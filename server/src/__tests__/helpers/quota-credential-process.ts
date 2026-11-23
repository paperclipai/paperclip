// A real receiver process for the credential-loss boundary test. No provider
// credentials leave this process through logs, IPC, or diagnostic exceptions.
import { createDb } from "@paperclipai/db";
import { aiConnectionService } from "../../services/ai-connections.js";

const db = createDb(process.env.CREDENTIAL_TEST_DATABASE_URL!);
const provider = process.env.CREDENTIAL_TEST_PROVIDER_URL!;
const request = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected fixture network request");
  return request(provider, init);
};
try {
  const service = aiConnectionService(db);
  const [row] = await service.quotaAccounts(process.env.CREDENTIAL_TEST_COMPANY_ID!, process.env.CREDENTIAL_TEST_OWNER!);
  await service.refreshQuotaCredential(row, await service.credential(row), new AbortController().signal);
  process.exitCode = 0;
} catch { process.exitCode = 1; }
finally { await db.$client.end(); }
