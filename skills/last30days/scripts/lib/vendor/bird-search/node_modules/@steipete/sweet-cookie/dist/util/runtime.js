export function isBunRuntime() {
    // Bun: https://bun.sh/docs/runtime/environment-variables#bun-specific
    if (typeof process === 'undefined')
        return false;
    const bunVersion = process.versions.bun;
    return Boolean(typeof process.versions === 'object' && typeof bunVersion === 'string');
}
//# sourceMappingURL=runtime.js.map