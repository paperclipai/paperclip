import { describe, expect, it } from "vitest";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
} from "./sandbox-callback-bridge.js";

const contextRequests = [
  { method: "GET", path: "/api/assets/screenshot-1/content" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1/files", query: "?path=references%2Fworkflow.md" },
  { method: "GET", path: "/api/issues/task-1/diagnostics/wakes" },
  { method: "POST", path: "/api/issues/task-1/monitor/check-now" },
];

const deniedRequests = [
  { method: "POST", path: "/api/assets/screenshot-1/content" },
  { method: "DELETE", path: "/api/assets/screenshot-1/content" },
  { method: "GET", path: "/api/assets/screenshot-1/content/extra" },
  { method: "PATCH", path: "/api/companies/company-1/skills/skill-1" },
  { method: "PATCH", path: "/api/companies/company-1/skills/skill-1/files" },
  { method: "DELETE", path: "/api/companies/company-1/skills/skill-1/files" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1/files/extra" },
  { method: "POST", path: "/api/issues/task-1/diagnostics/wakes" },
  { method: "GET", path: "/api/issues/task-1/diagnostics/wakes/extra" },
  { method: "GET", path: "/api/issues/task-1/monitor/check-now" },
  { method: "POST", path: "/api/issues/task-1/monitor/check-now/extra" },
  { method: "POST", path: "/api/issues/task-1/recovery-actions/resolve" },
];

describe.each([
  ["queue", undefined],
  ["HTTP/2", HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST],
] as const)("sandbox task context over %s", (_transport, routes) => {
  it.each(contextRequests)("admits documented context request $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes)).toBeNull();
  });

  it.each(deniedRequests)("keeps unrelated operations denied: $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes))
      .toBe(`Route not allowed: ${request.method} ${request.path}`);
  });
});
