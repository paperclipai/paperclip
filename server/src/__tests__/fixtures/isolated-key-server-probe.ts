import { createHash } from "node:crypto";
import { createDb } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";

// A fresh process models a server restart. Keep both the value and any errors
// out of stdout/stderr; the parent test checks only the exit status.
try {
  const dbUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  const companyId = process.env.PAPERCLIP_TEST_COMPANY_ID;
  const secretId = process.env.PAPERCLIP_TEST_SECRET_ID;
  const expectedHash = process.env.PAPERCLIP_TEST_VALUE_HASH;
  if (!dbUrl || !companyId || !secretId || !expectedHash) process.exit(2);
  const value = await secretService(createDb(dbUrl)).resolveSecretValue(companyId, secretId, "latest");
  const actualHash = createHash("sha256").update(value).digest("hex");
  process.exit(actualHash === expectedHash ? 0 : 3);
} catch (error) {
  // Only the error class and code are safe to report from this probe.
  const kind = error instanceof Error ? error.name : "UnknownError";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "none";
  process.stderr.write(`${kind}:${code}\n`);
  process.exit(4);
}
