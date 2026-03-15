import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandPath, looksLikePath } from './paths.js';
export function resolveChromiumCookiesDbLinux(options) {
    const home = homedir();
    // biome-ignore lint/complexity/useLiteralKeys: process.env is an index signature under strict TS.
    const configHome = process.env['XDG_CONFIG_HOME']?.trim() || path.join(home, '.config');
    const root = path.join(configHome, options.configDirName);
    if (options.profile && looksLikePath(options.profile)) {
        const candidate = expandPath(options.profile);
        if (candidate.endsWith('Cookies') && existsSync(candidate))
            return candidate;
        const direct = path.join(candidate, 'Cookies');
        if (existsSync(direct))
            return direct;
        const network = path.join(candidate, 'Network', 'Cookies');
        if (existsSync(network))
            return network;
        return null;
    }
    const profileDir = options.profile && options.profile.trim().length > 0 ? options.profile.trim() : 'Default';
    const candidates = [
        path.join(root, profileDir, 'Cookies'),
        path.join(root, profileDir, 'Network', 'Cookies'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
//# sourceMappingURL=linuxPaths.js.map