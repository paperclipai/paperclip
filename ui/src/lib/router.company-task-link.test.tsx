import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Link } from "./router";

const company = vi.hoisted(() => ({ issuePrefix: "ORG" }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: company }) }));

function href(location: string, to: string) {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[location]}>
      <QueryClientProvider client={new QueryClient()}>
        <Link to={to} disableIssueQuicklook>task</Link>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return html.match(/href="([^"]*)"/)?.[1];
}

describe("company task links through the real Link", () => {
  it("opens a task in a company whose prefix matches a board route name", () => {
    company.issuePrefix = "ORG";
    expect(href("/ORG/dashboard", "/ORG/issues/ORG-1")).toBe("/ORG/issues/ORG-1");
    expect(href("/ORG/dashboard", "/issues/ORG-1")).toBe("/ORG/issues/ORG-1");
  });

  it("keeps another company's task link in that company", () => {
    company.issuePrefix = "COM";
    expect(href("/COM/dashboard", "/BIR/issues/BIR-1")).toBe("/BIR/issues/BIR-1");
    expect(href("/COM/dashboard", "/ORG/issues/ORG-1")).toBe("/ORG/issues/ORG-1");
  });
});
