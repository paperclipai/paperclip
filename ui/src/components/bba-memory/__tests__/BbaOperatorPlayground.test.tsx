import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { mockExecutePanel, mockRunsPanel } = vi.hoisted(() => ({
  mockExecutePanel: vi.fn(),
  mockRunsPanel: vi.fn(),
}));

vi.mock("../BbaMemoryExecuteBetPanel", () => ({
  BbaMemoryExecuteBetPanel: (props: any) => {
    mockExecutePanel(props);
    return <div data-testid="mock-execute-panel" />;
  },
}));

vi.mock("../BbaMemoryRecentRunsPanel", () => ({
  default: (props: any) => {
    mockRunsPanel(props);
    return <div data-testid="mock-runs-panel" />;
  },
}));

import { BbaOperatorPlayground } from "../BbaOperatorPlayground";

beforeEach(() => {
  mockExecutePanel.mockClear();
  mockRunsPanel.mockClear();
});

describe("BbaOperatorPlayground", () => {
  it("renders 3 bookmaker options + 3 bet options", () => {
    render(<BbaOperatorPlayground companyId="c1" />);

    expect(screen.getByTestId("bookmaker-preset-select").querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByTestId("bet-preset-select").querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByText("Casa Pariurilor (RO)")).toBeInTheDocument();
    expect(screen.getByText("Betano (RO)")).toBeInTheDocument();
    expect(screen.getByText("Test mock (won't actually place)")).toBeInTheDocument();
  });

  it("default selection is first bookmaker + first bet preset", () => {
    render(<BbaOperatorPlayground companyId="c1" />);

    expect(screen.getByTestId("bookmaker-preset-select")).toHaveValue("casa-pariurilor");
    expect(screen.getByTestId("bet-preset-select")).toHaveValue("small-1x2");
    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("Team A vs Team B");
    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("RON 10");
    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("Casa Pariurilor");
  });

  it("switching bookmaker preset updates summary and child payload", () => {
    render(<BbaOperatorPlayground companyId="c1" />);

    fireEvent.change(screen.getByTestId("bookmaker-preset-select"), {
      target: { value: "betano" },
    });

    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("Betano");
    expect(mockExecutePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          bookmakerConfig: expect.objectContaining({ bookmaker: "Betano" }),
        }),
      }),
    );
  });

  it("switching bet preset updates summary and child payload", () => {
    render(<BbaOperatorPlayground companyId="c1" />);

    fireEvent.change(screen.getByTestId("bet-preset-select"), {
      target: { value: "smoke-tiny" },
    });

    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("RON 1");
    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("Smoke vs Test");
    expect(mockExecutePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          bet: expect.objectContaining({ stake: 1 }),
        }),
      }),
    );
  });

  it("passes companyId to both children", () => {
    render(<BbaOperatorPlayground companyId="acme-co" />);

    expect(mockExecutePanel).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "acme-co" }));
    expect(mockRunsPanel).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "acme-co" }));
  });

  it("renders divider between execute panel and recent runs panel", () => {
    const { container } = render(<BbaOperatorPlayground companyId="c1" />);

    const executePanel = screen.getByTestId("mock-execute-panel");
    const runsPanel = screen.getByTestId("mock-runs-panel");
    const divider = container.querySelector("hr");
    expect(divider).toBeInTheDocument();
    expect(executePanel.compareDocumentPosition(divider!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(divider!.compareDocumentPosition(runsPanel)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("snapshot of default state", () => {
    const { container } = render(<BbaOperatorPlayground companyId="c1" />);
    expect(container.firstChild?.textContent).toMatchInlineSnapshot(
      `"BBA Operator PlaygroundDemo and operator surface combining recent-runs visibility with execute-bet capability. Pick a bookmaker preset and a bet preset, then click Place Bet.Bookmaker presetCasa Pariurilor (RO)Betano (RO)Test mock (won't actually place)Bet presetSmall 1X2 — RON 10Medium Over/Under — RON 25Smoke test — RON 1Selected betTeam A vs Team B · 1X2 · 1 @ 1.85 for RON 10 on Casa Pariurilor"`,
    );
  });
});
