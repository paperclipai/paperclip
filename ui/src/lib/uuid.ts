function uuidFromRandomBytes(): string {
  const webCrypto = globalThis.crypto;
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function insecureRandomUuid(): `${string}-${string}-${string}-${string}-${string}` {
  return uuidFromRandomBytes() as `${string}-${string}-${string}-${string}-${string}`;
}

/** Browser UUIDs also work on plain-HTTP LAN and tailnet previews. */
export function createUuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  // Skip the function installInsecureRandomUuid puts on crypto. That function
  // is insecureRandomUuid. If it ever called randomUUID, this call would recurse.
  if (typeof randomUUID === "function" && randomUUID !== insecureRandomUuid) return randomUUID.call(globalThis.crypto);
  return uuidFromRandomBytes();
}

export function installInsecureRandomUuid(): void {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.randomUUID === "function") return;
  try {
    Object.defineProperty(webCrypto, "randomUUID", { configurable: true, value: insecureRandomUuid });
  } catch {
    return;
  }
}
