export interface SandboxCallbackBridgeBody {
  body: string;
  /** Omitted by older queue peers, whose bodies are UTF-8 text. */
  bodyEncoding?: "utf8" | "base64";
}

/** JSON can escape each input byte as six characters. Metadata is bounded too. */
export function sandboxBridgeEnvelopeLimit(maxBodyBytes: number): number {
  return 6 * maxBodyBytes + 64 * 1024;
}

export function encodeSandboxBridgeBody(body: string | Buffer, maxBodyBytes: number): SandboxCallbackBridgeBody {
  if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Bridge body exceeded the configured size limit.");
  return Buffer.isBuffer(body) ? { body: body.toString("base64"), bodyEncoding: "base64" } : { body };
}

/** Self-contained so the same decoder can be embedded in the remote gateway. */
export function decodeSandboxBridgeBody(envelope: SandboxCallbackBridgeBody, maxBodyBytes: number): Buffer {
  if (!envelope || typeof envelope.body !== "string") throw new Error("Invalid bridge body.");
  if (envelope.bodyEncoding === undefined || envelope.bodyEncoding === "utf8") {
    if (Buffer.byteLength(envelope.body, "utf8") > maxBodyBytes) throw new Error("Bridge body exceeded the configured size limit.");
    return Buffer.from(envelope.body, "utf8");
  }
  if (envelope.bodyEncoding !== "base64") throw new Error("Unsupported bridge body encoding.");
  const value = envelope.body;
  if (value.length > 4 * Math.ceil(maxBodyBytes / 3)) throw new Error("Bridge body exceeded the configured size limit.");
  // Buffer.from is permissive; reject malformed input before allocating bytes.
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid bridge base64 body.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBodyBytes) throw new Error("Bridge body exceeded the configured size limit.");
  if (bytes.toString("base64") !== value) throw new Error("Invalid bridge base64 body.");
  return bytes;
}

export function sandboxBridgeBodyCodecSource(): string {
  return [sandboxBridgeEnvelopeLimit, encodeSandboxBridgeBody, decodeSandboxBridgeBody]
    .map(fn => `const ${fn.name} = ${fn.toString()};`).join("\n");
}
