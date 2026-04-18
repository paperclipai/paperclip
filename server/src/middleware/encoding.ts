import type { Request, Response, NextFunction } from "express";

/**
 * On Windows with Chinese locale (GBK code page), JSON body string fields may
 * contain GBK-encoded bytes misinterpreted as UTF-8. This middleware detects
 * and corrects such fields by attempting strict UTF-8 validation and falling
 * back to GBK decoding.
 */
export function encodingFallbackMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (
      req.body &&
      typeof req.body === "object" &&
      (req.method === "POST" || req.method === "PATCH")
    ) {
      req.body = fixEncodingDeep(req.body);
    }
    next();
  };
}

function fixEncodingDeep(obj: unknown): unknown {
  if (typeof obj === "string") {
    return fixStringEncoding(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(fixEncodingDeep);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = fixEncodingDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Detect GBK-as-UTF-8 mojibake in a string. If the string contains byte
 * sequences that are invalid UTF-8 but valid GBK, re-decode from GBK.
 */
function fixStringEncoding(str: string): string {
  // Fast path: skip strings that are pure ASCII or look fine
  if (isAscii(str)) return str;

  // Encode the string back to bytes using latin1 (preserves raw byte values)
  // then check if those bytes are valid UTF-8
  const buf = Buffer.from(str, "latin1");

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf);
    return str; // Valid UTF-8, no fix needed
  } catch {
    // Contains invalid UTF-8 — re-interpret as GBK
    const gbkDecoder = new TextDecoder("gbk");
    return gbkDecoder.decode(buf);
  }
}

function isAscii(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) return false;
  }
  return true;
}
