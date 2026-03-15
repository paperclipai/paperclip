let cached = null;
export function supportsReadBigInts() {
    const [majorRaw, minorRaw] = process.versions.node.split('.');
    const major = Number.parseInt(majorRaw ?? '', 10);
    const minor = Number.parseInt(minorRaw ?? '', 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor))
        return false;
    if (major > 24)
        return true;
    if (major < 24)
        return false;
    return minor >= 4;
}
function shouldSuppressSqliteExperimentalWarning(warning, args) {
    const message = typeof warning === 'string'
        ? warning
        : warning instanceof Error
            ? warning.message
            : typeof warning?.message === 'string'
                ? warning.message
                : null;
    if (!message || !message.includes('SQLite is an experimental feature'))
        return false;
    // Best-effort: only swallow the one noisy warning that Node emits when loading `node:sqlite`.
    // We do *not* suppress arbitrary warnings, and we restore the original handler immediately.
    const firstArg = args[0];
    if (firstArg === 'ExperimentalWarning')
        return true;
    if (typeof firstArg === 'object' && firstArg) {
        const type = firstArg.type;
        if (type === 'ExperimentalWarning')
            return true;
    }
    if (warning instanceof Error && warning.name === 'ExperimentalWarning')
        return true;
    return false;
}
export async function importNodeSqlite() {
    if (cached)
        return cached;
    // Node currently emits an ExperimentalWarning when importing `node:sqlite`.
    // This is harmless noise for consumers of this library, so we silence only that specific warning.
    const originalEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = ((warning, ...args) => {
        if (shouldSuppressSqliteExperimentalWarning(warning, args))
            return;
        // @ts-expect-error - Node's overloads are awkward; preserve runtime behavior.
        return originalEmitWarning(warning, ...args);
    });
    try {
        cached = await import('node:sqlite');
        return cached;
    }
    finally {
        process.emitWarning = originalEmitWarning;
    }
}
//# sourceMappingURL=nodeSqlite.js.map