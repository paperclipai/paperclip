import { execCapture } from '../../util/exec.js';
/**
 * Read the "Safe Storage" password from a Linux keyring.
 *
 * Chromium browsers typically store their cookie encryption password under:
 * - service: "<Browser> Safe Storage"
 * - account: "<Browser>"
 *
 * We keep this logic in JS (no native deps) and return an empty password on failure
 * (Chromium may still have v10 cookies, and callers can use inline/export escape hatches).
 */
export async function getLinuxChromiumSafeStoragePassword(options) {
    const warnings = [];
    // Escape hatch: if callers already know the password (or want deterministic CI behavior),
    // they can bypass keyring probing entirely.
    const overrideKey = options.app === 'edge'
        ? 'SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD'
        : 'SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD';
    const override = readEnv(overrideKey);
    if (override !== undefined)
        return { password: override, warnings };
    const backend = options.backend ?? parseLinuxKeyringBackend() ?? chooseLinuxKeyringBackend();
    // `basic` means "don't try keyrings" (Chrome will fall back to older/less-secure schemes on some setups).
    if (backend === 'basic')
        return { password: '', warnings };
    const service = options.app === 'edge' ? 'Microsoft Edge Safe Storage' : 'Chrome Safe Storage';
    const account = options.app === 'edge' ? 'Microsoft Edge' : 'Chrome';
    const folder = `${account} Keys`;
    if (backend === 'gnome') {
        // GNOME keyring: `secret-tool` is the simplest way to read libsecret entries.
        const res = await execCapture('secret-tool', ['lookup', 'service', service, 'account', account], { timeoutMs: 3_000 });
        if (res.code === 0)
            return { password: res.stdout.trim(), warnings };
        warnings.push('Failed to read Linux keyring via secret-tool; v11 cookies may be unavailable.');
        return { password: '', warnings };
    }
    // KDE keyring: query KWallet via `kwallet-query`, but the wallet name differs across KDE versions.
    const kdeVersion = (readEnv('KDE_SESSION_VERSION') ?? '').trim();
    const serviceName = kdeVersion === '6'
        ? 'org.kde.kwalletd6'
        : kdeVersion === '5'
            ? 'org.kde.kwalletd5'
            : 'org.kde.kwalletd';
    const walletPath = kdeVersion === '6'
        ? '/modules/kwalletd6'
        : kdeVersion === '5'
            ? '/modules/kwalletd5'
            : '/modules/kwalletd';
    const wallet = await getKWalletNetworkWallet(serviceName, walletPath);
    const passwordRes = await execCapture('kwallet-query', ['--read-password', service, '--folder', folder, wallet], { timeoutMs: 3_000 });
    if (passwordRes.code !== 0) {
        warnings.push('Failed to read Linux keyring via kwallet-query; v11 cookies may be unavailable.');
        return { password: '', warnings };
    }
    if (passwordRes.stdout.toLowerCase().startsWith('failed to read'))
        return { password: '', warnings };
    return { password: passwordRes.stdout.trim(), warnings };
}
export async function getLinuxChromeSafeStoragePassword(options = {}) {
    const args = { app: 'chrome' };
    if (options.backend !== undefined)
        args.backend = options.backend;
    return await getLinuxChromiumSafeStoragePassword(args);
}
function parseLinuxKeyringBackend() {
    const raw = readEnv('SWEET_COOKIE_LINUX_KEYRING');
    if (!raw)
        return undefined;
    const normalized = raw.toLowerCase();
    if (normalized === 'gnome')
        return 'gnome';
    if (normalized === 'kwallet')
        return 'kwallet';
    if (normalized === 'basic')
        return 'basic';
    return undefined;
}
function chooseLinuxKeyringBackend() {
    const xdg = readEnv('XDG_CURRENT_DESKTOP') ?? '';
    const isKde = xdg.split(':').some((p) => p.trim().toLowerCase() === 'kde') || !!readEnv('KDE_FULL_SESSION');
    return isKde ? 'kwallet' : 'gnome';
}
async function getKWalletNetworkWallet(serviceName, walletPath) {
    const res = await execCapture('dbus-send', [
        '--session',
        '--print-reply=literal',
        `--dest=${serviceName}`,
        walletPath,
        'org.kde.KWallet.networkWallet',
    ], { timeoutMs: 3_000 });
    const fallback = 'kdewallet';
    if (res.code !== 0)
        return fallback;
    const raw = res.stdout.trim();
    if (!raw)
        return fallback;
    return raw.replaceAll('"', '').trim() || fallback;
}
function readEnv(key) {
    const value = process.env[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length ? trimmed : undefined;
}
//# sourceMappingURL=linuxKeyring.js.map