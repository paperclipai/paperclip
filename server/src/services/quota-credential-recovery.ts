import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { ensureDurableDirectory, syncDirectory } from "../lib/durable-directory.js";

const recoverySchema = z.object({
  companyId: z.string().uuid(), grantId: z.string().uuid(), connectionId: z.string().uuid(), secretId: z.string().uuid(),
  baseHash: z.string().length(64), value: z.string().min(1),
});
type Recovery = z.infer<typeof recoverySchema>;
export const quotaCredentialHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const quotaCredentialRecoveryPath = (companyId: string, grantId: string) =>
  path.join(resolvePaperclipInstanceRoot(), "quota-credential-recovery", companyId, `${grantId}.json`);

/** Called only while holding the company credential mutation lock. The local
 * encrypted provider uses the instance secrets master key, including when the
 * destination vault is remote. No plaintext token enters this journal. */
export function quotaCredentialRecovery(companyId: string, grantId: string) {
  const file = quotaCredentialRecoveryPath(companyId, grantId);
  const directory = path.dirname(file);
  async function writeEncrypted(target: string, value: string) {
    const encrypted = await localEncryptedProvider.createVersion({ value });
    await ensureDurableDirectory(directory);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(encrypted.material)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
      await syncDirectory(directory);
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  return {
    // Verify encryption, storage, and fsync before exchanging a single-use token.
    prepare: async () => {
      const probe = `${file}.${randomUUID()}.probe`;
      try { await writeEncrypted(probe, "credential-recovery-probe"); }
      finally { await fs.rm(probe, { force: true }); }
    },
    read: async (): Promise<Recovery | null> => {
      let material: string;
      try { material = await fs.readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const pending = recoverySchema.parse(JSON.parse(await localEncryptedProvider.resolveVersion({ material: JSON.parse(material), externalRef: null })));
      if (pending.companyId !== companyId || pending.grantId !== grantId) throw new Error("credentials_unavailable");
      return pending;
    },
    write: (input: Recovery) => writeEncrypted(file, JSON.stringify(recoverySchema.parse(input))),
    clear: async () => { await fs.rm(file, { force: true }); },
  };
}
