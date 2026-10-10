import { normalizeCompanyState } from "./state.mjs";
import { classifyAction } from "./policy.mjs";

function requestError(status) {
  return new Error(`Paperclip request failed: ${status}`);
}

function scalar(value) {
  return ["string", "number", "boolean"].includes(typeof value) && value !== "" ? value : undefined;
}

function sanitizeApproval(approval) {
  const source = approval && typeof approval === "object" ? approval : {};
  // Approval payloads can contain credentials and runtime configuration. Keep
  // only top-level display/status fields from the allowlist; never copy payload
  // or trust a non-contract `protected` field supplied by the upstream.
  const classification = classifyAction({ type: scalar(source.type) });
  return {
    id: scalar(source.id),
    type: scalar(source.type),
    status: scalar(source.status),
    title: scalar(source.title),
    categories: classification.categories,
  };
}

function sanitizeCollection(value) {
  return Array.isArray(value) ? value : [];
}

export function createPaperclipClient({ baseUrl, apiKey, fetchImpl = fetch, requestTimeoutMs = 5_000 } = {}) {
  const root = String(baseUrl ?? "").replace(/\/$/, "");

  async function get(path) {
    const controller = new AbortController();
    const timeout = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
      ? setTimeout(() => controller.abort(), Number(requestTimeoutMs))
      : null;
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
      });
    } catch {
      throw requestError(controller.signal.aborted ? "timeout" : "network");
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response?.ok) throw requestError(response?.status ?? "unknown");

    try {
      return await response.json();
    } catch {
      throw requestError("invalid response");
    }
  }

  return {
    async readCompanyState(companyId) {
      const encodedId = encodeURIComponent(String(companyId));
      const [company, dashboard, agents, routines, issues, approvals] = await Promise.all([
        get(`/api/companies/${encodedId}`),
        get(`/api/companies/${encodedId}/dashboard`),
        get(`/api/companies/${encodedId}/agents`),
        get(`/api/companies/${encodedId}/routines`),
        get(`/api/companies/${encodedId}/issues?limit=20`),
        get(`/api/companies/${encodedId}/approvals`),
      ]);

      return normalizeCompanyState({
        company,
        dashboard,
        agents: sanitizeCollection(agents),
        routines: sanitizeCollection(routines),
        issues: sanitizeCollection(issues),
        approvals: sanitizeCollection(approvals).map(sanitizeApproval),
      });
    },
  };
}
