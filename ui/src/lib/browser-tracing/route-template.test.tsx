import { describe, expect, it } from "vitest";
import { Route } from "react-router-dom";
import { routeTemplateForElements, UNMATCHED_ROUTE_TEMPLATE } from "./route-template";

const Page = () => null;

const routes = (
  <>
    <Route path="auth" element={<Page />} />
    <Route path="invite/:token" element={<Page />} />
    <Route element={<Page />}>
      <Route index element={<Page />} />
      <Route path="issues/:issueId" element={<Page />} />
      <Route path=":companyPrefix" element={<Page />}>
        <Route path="issues" element={<Page />} />
        <Route path="issues/:issueId" element={<Page />} />
        <Route path="agents/:agentId/runs/:runId" element={<Page />} />
        <Route path=":pluginRoutePath/*" element={<Page />} />
      </Route>
    </Route>
  </>
);

describe("routeTemplateForElements", () => {
  it.each([
    ["/PAP/issues", "/:companyPrefix/issues"],
    ["/PAP/issues/PAP-1234", "/:companyPrefix/issues/:issueId"],
    ["/PAP/issues/PAP-1234/", "/:companyPrefix/issues/:issueId"],
    ["/issues/0f6b6d1e-2c4f-4b5e-9f00-123456789abc", "/issues/:issueId"],
    ["/PAP/agents/3e1/runs/77d", "/:companyPrefix/agents/:agentId/runs/:runId"],
    ["/invite/secret-token-value", "/invite/:token"],
    ["/PAP/some-plugin/deep/path/9", "/:companyPrefix/:pluginRoutePath/*"],
    ["/", "/"],
  ])("reports %s as %s", (pathname, template) => {
    expect(routeTemplateForElements(routes, pathname)).toBe(template);
  });

  it("never includes ids, slugs, or tokens from the concrete path", () => {
    const concrete = [
      "/ACME/issues/ACME-98765",
      "/invite/tok_abcdef123",
      "/ACME/agents/agent-uuid-1/runs/run-uuid-2",
      "/ACME/my-plugin/customer-name/42",
    ];
    for (const pathname of concrete) {
      const template = routeTemplateForElements(routes, pathname);
      for (const part of pathname.split("/").filter(Boolean)) {
        if (["issues", "invite", "agents", "runs"].includes(part)) continue;
        expect(template).not.toContain(part);
      }
    }
  });

  it("reports an unmatched path without echoing it", () => {
    const narrow = <Route path="auth" element={<Page />} />;
    expect(routeTemplateForElements(narrow, "/private/PAP-1")).toBe(UNMATCHED_ROUTE_TEMPLATE);
  });
});
