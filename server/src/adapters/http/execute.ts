import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";
import { guardedHttpAdapterFetch } from "./remote-fetch.js";
import { createHttpRunAttestation, RUN_ATTESTATION_HEADER } from "./run-attestation.js";

const MAX_ATTESTED_BODY_BYTES = 2048;

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, issueId } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, asNumber(config.timeoutSec, 0) * 1000);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  if (config.runAttestation !== undefined && typeof config.runAttestation !== "boolean") {
    throw new Error("HTTP runAttestation must be a boolean");
  }
  const attest = config.runAttestation === true;
  if (Object.keys(headers).some((key) => key.toLowerCase() === RUN_ATTESTATION_HEADER)) {
    throw new Error("HTTP run attestation header is reserved");
  }
  if (attest && Object.keys(headers).length > 0) {
    throw new Error("HTTP run attestation forbids configured headers");
  }
  if (attest && Object.keys(payloadTemplate).length > 0) {
    throw new Error("HTTP run attestation forbids a payload template");
  }
  if (attest && method.toUpperCase() !== "POST") {
    throw new Error("HTTP run attestation requires POST");
  }

  const verifiedIssueId = issueId ?? "";
  const attestation = attest
    ? createHttpRunAttestation({
        url,
        agentId: agent.id,
        companyId: agent.companyId,
        runId,
        issueId: verifiedIssueId,
      })
    : null;
  const requestUrl = attestation ? new URL(url).href : url;
  const body = attestation
    ? { agentId: agent.id, companyId: agent.companyId, runId, issueId: verifiedIssueId }
    : {
        ...payloadTemplate,
        agentId: agent.id,
        runId,
        context,
        connectionInstructions: context.connectionInstructions ?? null,
        ...(ctx.runtimeTools ? { paperclipRuntimeTools: ctx.runtimeTools } : {}),
      };
  const bodyText = JSON.stringify(body);
  if (attestation && Buffer.byteLength(bodyText, "utf8") > MAX_ATTESTED_BODY_BYTES) {
    throw new Error("HTTP run attestation payload exceeds the size limit");
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    // HTTP adapters have no child-process spawn event. Signal immediately
    // before starting the remote request so dispatch gates can release without
    // waiting for the endpoint to respond.
    ctx.onDispatch?.();
    const res = await guardedHttpAdapterFetch(requestUrl, {
      method: attestation ? "POST" : method,
      headers: {
        "content-type": "application/json",
        ...headers,
        ...(attestation ? { [RUN_ATTESTATION_HEADER]: attestation } : {}),
      },
      body: bodyText,
      ...(attestation ? { redirect: "error" as const } : {}),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
