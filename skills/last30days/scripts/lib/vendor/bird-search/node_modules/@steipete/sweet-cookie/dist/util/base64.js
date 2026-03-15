export function tryDecodeBase64Json(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    try {
        const encoding = /[-_]/.test(trimmed) ? 'base64url' : 'base64';
        const buf = Buffer.from(trimmed, encoding);
        const decoded = buf.toString('utf8').trim();
        if (!decoded)
            return null;
        JSON.parse(decoded);
        return decoded;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=base64.js.map