import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dpapiUnprotect } from '../chromeSqlite/windowsDpapi.js';
export async function getWindowsChromiumMasterKey(userDataDir, label) {
    const localStatePath = path.join(userDataDir, 'Local State');
    if (!existsSync(localStatePath)) {
        return { ok: false, error: `${label} Local State file not found.` };
    }
    let encryptedKeyB64 = null;
    try {
        const raw = readFileSync(localStatePath, 'utf8');
        const parsed = JSON.parse(raw);
        encryptedKeyB64 =
            typeof parsed.os_crypt?.encrypted_key === 'string' ? parsed.os_crypt.encrypted_key : null;
    }
    catch (error) {
        return {
            ok: false,
            error: `Failed to parse ${label} Local State: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!encryptedKeyB64)
        return { ok: false, error: `${label} Local State missing os_crypt.encrypted_key.` };
    let encryptedKey;
    try {
        encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
    }
    catch {
        return { ok: false, error: `${label} Local State contains an invalid encrypted_key.` };
    }
    const prefix = Buffer.from('DPAPI', 'utf8');
    if (!encryptedKey.subarray(0, prefix.length).equals(prefix)) {
        return { ok: false, error: `${label} encrypted_key does not start with DPAPI prefix.` };
    }
    const unprotected = await dpapiUnprotect(encryptedKey.subarray(prefix.length));
    if (!unprotected.ok) {
        return { ok: false, error: `DPAPI decrypt failed: ${unprotected.error}` };
    }
    return { ok: true, value: unprotected.value };
}
//# sourceMappingURL=windowsMasterKey.js.map