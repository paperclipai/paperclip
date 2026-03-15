import { execCapture } from '../../util/exec.js';
export async function readKeychainGenericPassword(options) {
    const res = await execCapture('security', ['find-generic-password', '-w', '-a', options.account, '-s', options.service], { timeoutMs: options.timeoutMs });
    if (res.code === 0) {
        const password = res.stdout.trim();
        return { ok: true, password };
    }
    return {
        ok: false,
        error: `${res.stderr.trim() || `exit ${res.code}`}`,
    };
}
export async function readKeychainGenericPasswordFirst(options) {
    let lastError = null;
    for (const service of options.services) {
        const r = await readKeychainGenericPassword({
            account: options.account,
            service,
            timeoutMs: options.timeoutMs,
        });
        if (r.ok)
            return r;
        lastError = r.error;
    }
    return {
        ok: false,
        error: `Failed to read macOS Keychain (${options.label}): ${lastError ?? 'permission denied / keychain locked / entry missing.'}`,
    };
}
//# sourceMappingURL=macosKeychain.js.map