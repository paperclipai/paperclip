export function normalizeOrigins(url, extraOrigins) {
    const origins = [];
    try {
        const parsed = new URL(url);
        origins.push(ensureTrailingSlash(parsed.origin));
    }
    catch {
        // ignore
    }
    for (const raw of extraOrigins ?? []) {
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = new URL(trimmed);
            origins.push(ensureTrailingSlash(parsed.origin));
        }
        catch {
            // ignore malformed extras
        }
    }
    return Array.from(new Set(origins));
}
function ensureTrailingSlash(origin) {
    return origin.endsWith('/') ? origin : `${origin}/`;
}
//# sourceMappingURL=origins.js.map