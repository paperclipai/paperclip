import { oauthLogger } from "./logger.js";

const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [200, 600];  // 2 retries on 5xx

export interface ExchangeTokenInput {
  url: string;
  params: Record<string, string>;
  authMethod: "post" | "basic";
  responseFormat: "json" | "form";
  clientId: string;
  clientSecret: string;
}

export class OAuthRequestError extends Error {
  status: number;
  body: string;
  parsed: Record<string, unknown>;
  providerErrorCode?: string;

  constructor(
    message: string,
    init: { status: number; body: string; parsed?: Record<string, unknown>; providerErrorCode?: string },
  ) {
    super(message);
    this.name = "OAuthRequestError";
    this.status = init.status;
    this.body = init.body;
    this.parsed = init.parsed ?? {};
    this.providerErrorCode = init.providerErrorCode;
  }
}

const SENSITIVE_KEYS = ["access_token", "refresh_token", "id_token", "code", "code_verifier", "client_secret"];

function sanitizeErrorBody(text: string): string {
  if (!text) return "";
  const jsonRe = new RegExp(`("(?:${SENSITIVE_KEYS.join("|")})"\\s*:\\s*)"[^"]*"`, "g");
  const formRe = new RegExp(`(${SENSITIVE_KEYS.join("|")})=([^&\\s]+)`, "g");
  const sanitized = text.replace(jsonRe, '$1"[REDACTED]"').replace(formRe, "$1=[REDACTED]");
  return sanitized.slice(0, 200);
}

export async function exchangeToken(input: ExchangeTokenInput): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(input.params)) body.set(k, v);
  if (input.authMethod === "post") {
    body.set("client_id", input.clientId);
    body.set("client_secret", input.clientSecret);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "accept": input.responseFormat === "json" ? "application/json" : "application/x-www-form-urlencoded",
  };
  if (input.authMethod === "basic") {
    const credentials = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${credentials}`;
  }

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(input.url, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(t);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        attempt++;
        continue;
      }
      throw err;
    }
    clearTimeout(t);

    const text = await res.text();
    let parsed: Record<string, unknown>;
    let parseFailed = false;
    try {
      parsed = input.responseFormat === "json" ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    } catch {
      parsed = {};
      parseFailed = true;
    }

    if (res.ok) {
      if (parseFailed) {
        throw new OAuthRequestError("token endpoint returned unparseable body", {
          status: res.status,
          body: sanitizeErrorBody(text),
          parsed: {},
        });
      }
      return parsed;
    }

    if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      oauthLogger.warn({ status: res.status, attempt }, "token endpoint 5xx; retrying");
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      attempt++;
      continue;
    }

    const safeBody = sanitizeErrorBody(text);
    const providerErrorCode = typeof parsed.error === "string" ? parsed.error : undefined;
    const messageSuffix = providerErrorCode ?? safeBody;
    throw new OAuthRequestError(
      `token exchange failed: ${res.status}${messageSuffix ? ` ${messageSuffix}` : ""}`,
      {
        status: res.status,
        body: safeBody,
        parsed,
        providerErrorCode,
      },
    );
  }
}

export async function fetchAccountInfo(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "paperclip-oauth/1.0",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const safeBody = sanitizeErrorBody(text);
      throw new OAuthRequestError(
        `account info fetch failed: ${res.status}${safeBody ? ` ${safeBody}` : ""}`,
        {
          status: res.status,
          body: safeBody,
        },
      );
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
