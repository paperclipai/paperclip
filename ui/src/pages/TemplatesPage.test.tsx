// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type React from "react";
import { TemplatesPage } from "./TemplatesPage";
import { templatesApi } from "../api/templates";

vi.mock("../api/templates", () => ({
  templatesApi: {
    list: vi.fn(),
    install: vi.fn(),
    refresh: vi.fn(),
  },
}));

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TemplatesPage", () => {
  beforeEach(() => {
    vi.mocked(templatesApi.list).mockReset();
    vi.mocked(templatesApi.install).mockReset();
  });

  it("renders loading state initially", () => {
    vi.mocked(templatesApi.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<TemplatesPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders fetched companies", async () => {
    vi.mocked(templatesApi.list).mockResolvedValue({
      companies: [
        { slug: "a", name: "A Corp", description: "x", agents_count: 5, skills_count: 2, tags: [], url: "https://example.com" },
      ],
    });
    renderWithProviders(<TemplatesPage />);
    await waitFor(() => expect(screen.getByText("A Corp")).toBeInTheDocument());
  });

  it("triggers install mutation on click", async () => {
    vi.mocked(templatesApi.list).mockResolvedValue({
      companies: [
        { slug: "a", name: "A Corp", description: "x", agents_count: 5, skills_count: 2, tags: [], url: "https://example.com" },
      ],
    });
    vi.mocked(templatesApi.install).mockResolvedValue({ companyId: "new-1", name: "A Corp", agentsCreated: 5 });
    renderWithProviders(<TemplatesPage />);
    await waitFor(() => screen.getByRole("button", { name: /install/i }));
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    await waitFor(() => expect(templatesApi.install).toHaveBeenCalledWith({ slug: "a" }));
  });
});
