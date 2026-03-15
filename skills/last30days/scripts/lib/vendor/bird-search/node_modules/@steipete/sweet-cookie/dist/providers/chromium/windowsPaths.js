import { existsSync } from 'node:fs';
import path from 'node:path';
import { expandPath, looksLikePath } from './paths.js';
export function resolveChromiumPathsWindows(options) {
    // biome-ignore lint/complexity/useLiteralKeys: process.env is an index signature under strict TS.
    const localAppData = process.env['LOCALAPPDATA'];
    const root = localAppData ? path.join(localAppData, options.localAppDataVendorPath) : null;
    if (options.profile && looksLikePath(options.profile)) {
        const expanded = expandPath(options.profile);
        const candidates = expanded.endsWith('Cookies')
            ? [expanded]
            : [
                path.join(expanded, 'Network', 'Cookies'),
                path.join(expanded, 'Cookies'),
                path.join(expanded, 'Default', 'Network', 'Cookies'),
            ];
        for (const candidate of candidates) {
            if (!existsSync(candidate))
                continue;
            const userDataDir = findUserDataDir(candidate);
            return { dbPath: candidate, userDataDir };
        }
        if (existsSync(path.join(expanded, 'Local State'))) {
            return { dbPath: null, userDataDir: expanded };
        }
    }
    const profileDir = options.profile && options.profile.trim().length > 0 ? options.profile.trim() : 'Default';
    if (!root)
        return { dbPath: null, userDataDir: null };
    const candidates = [
        path.join(root, profileDir, 'Network', 'Cookies'),
        path.join(root, profileDir, 'Cookies'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return { dbPath: candidate, userDataDir: root };
    }
    return { dbPath: null, userDataDir: root };
}
function findUserDataDir(cookiesDbPath) {
    let current = path.dirname(cookiesDbPath);
    for (let i = 0; i < 6; i += 1) {
        const localState = path.join(current, 'Local State');
        if (existsSync(localState))
            return current;
        const next = path.dirname(current);
        if (next === current)
            break;
        current = next;
    }
    return null;
}
//# sourceMappingURL=windowsPaths.js.map