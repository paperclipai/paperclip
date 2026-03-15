import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
export function deriveAes128CbcKeyFromPassword(password, options) {
    // Chromium derives the AES-128-CBC key from "Chrome Safe Storage" using PBKDF2.
    // The salt/length/digest are fixed by Chromium ("saltysalt", 16 bytes, sha1).
    return pbkdf2Sync(password, 'saltysalt', options.iterations, 16, 'sha1');
}
export function decryptChromiumAes128CbcCookieValue(encryptedValue, keyCandidates, options) {
    const buf = Buffer.from(encryptedValue);
    if (buf.length < 3)
        return null;
    // Chromium prefixes encrypted cookies with `v10`, `v11`, ... (three bytes).
    const prefix = buf.subarray(0, 3).toString('utf8');
    const hasVersionPrefix = /^v\d\d$/.test(prefix);
    if (!hasVersionPrefix) {
        // Some platforms (notably macOS) can store plaintext values in `encrypted_value`.
        // Callers decide whether unknown prefixes should be treated as plaintext.
        if (options.treatUnknownPrefixAsPlaintext === false)
            return null;
        return decodeCookieValueBytes(buf, false);
    }
    const ciphertext = buf.subarray(3);
    if (!ciphertext.length)
        return '';
    for (const key of keyCandidates) {
        // Try multiple candidates because Linux may fall back to empty passwords depending on keyring state.
        const decrypted = tryDecryptAes128Cbc(ciphertext, key);
        if (!decrypted)
            continue;
        const decoded = decodeCookieValueBytes(decrypted, options.stripHashPrefix);
        if (decoded !== null)
            return decoded;
    }
    return null;
}
export function decryptChromiumAes256GcmCookieValue(encryptedValue, key, options) {
    const buf = Buffer.from(encryptedValue);
    if (buf.length < 3)
        return null;
    const prefix = buf.subarray(0, 3).toString('utf8');
    if (!/^v\d\d$/.test(prefix))
        return null;
    // AES-256-GCM layout:
    // - 12-byte nonce
    // - ciphertext
    // - 16-byte authentication tag
    const payload = buf.subarray(3);
    if (payload.length < 12 + 16)
        return null;
    const nonce = payload.subarray(0, 12);
    const authenticationTag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(12, payload.length - 16);
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(authenticationTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decodeCookieValueBytes(plaintext, options.stripHashPrefix);
    }
    catch {
        return null;
    }
}
function tryDecryptAes128Cbc(ciphertext, key) {
    try {
        // Chromium's legacy AES-128-CBC uses an IV of 16 spaces.
        const iv = Buffer.alloc(16, 0x20);
        const decipher = createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(false);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return removePkcs7Padding(plaintext);
    }
    catch {
        return null;
    }
}
function removePkcs7Padding(value) {
    if (!value.length)
        return value;
    const padding = value[value.length - 1];
    if (!padding || padding > 16)
        return value;
    return value.subarray(0, value.length - padding);
}
function decodeCookieValueBytes(value, stripHashPrefix) {
    // Chromium >= 24 prepends a 32-byte hash to cookie values.
    const bytes = stripHashPrefix && value.length >= 32 ? value.subarray(32) : value;
    try {
        return stripLeadingControlChars(UTF8_DECODER.decode(bytes));
    }
    catch {
        return null;
    }
}
function stripLeadingControlChars(value) {
    let i = 0;
    while (i < value.length && value.charCodeAt(i) < 0x20)
        i += 1;
    return value.slice(i);
}
//# sourceMappingURL=crypto.js.map