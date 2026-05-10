import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BbaMemoryExecuteBetPanel } from "../BbaMemoryExecuteBetPanel";
import * as bbaApi from "../../../api/bbaMemory";
import type { ExecuteBetRequest } from "../../../api/bbaMemory";

vi.mock("../../../api/bbaMemory", () => ({
  executeBbaBet: vi.fn(),
}));

const mockExecute = vi.mocked(bbaApi.executeBbaBet);

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const PAYLOAD: ExecuteBetRequest = {
  loginUsername: { secretName: "bba-user" },
  loginPassword: { secretName: "bba-pass" },
  bookmakerConfig: {
    bookmaker: "Betano",
    baseUrl: "https://betano.ro",
    loginUrl: "https://betano.ro/login",
    username: { selector: "#user" },
    password: { selector: "#pass" },
    loginSubmit: { selector: "#submit" },
    selectionButton: { selector: ".selection" },
    stakeInput: { selector: "#stake" },
    reviewButton: { selector: "#review" },
  },
  bet: { matchLabel: "Team A vs Team B", market: "1X2", selection: "1", odds: 2.5, stake: 10 },
  riskControls: { maxStakePerBet: 50, maxTotalStakePerSession: 200 },
};

const SUMMARY = {
  matchLabel: "Team A vs Team B",
  market: "1X2",
  selection: "1",
  odds: 2.5,
  stake: 10,
  bookmaker: "Betano",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BbaMemoryExecuteBetPanel", () => {
  it("renders place-bet button disabled when payload is null", () => {
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={null} betSummary={null} />,
      { wrapper: makeWrapper() },
    );
    expect(screen.getByTestId("place-bet-button")).toBeDisabled();
  });

  it("renders place-bet button enabled when payload provided", () => {
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    expect(screen.getByTestId("place-bet-button")).not.toBeDisabled();
  });

  it("opens confirmation modal on button click", () => {
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    expect(screen.getByTestId("confirm-modal-overlay")).toBeInTheDocument();
  });

  it("confirm button disabled until CONFIRM is typed", () => {
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    expect(screen.getByTestId("confirm-submit-button")).toBeDisabled();
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    expect(screen.getByTestId("confirm-submit-button")).not.toBeDisabled();
  });

  it("calls executeBbaBet and shows success result panel", async () => {
    mockExecute.mockResolvedValueOnce({ status: "success", placedBetId: "bet-123" });
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByTestId("confirm-submit-button"));
    await waitFor(() => expect(screen.getByTestId("result-panel")).toBeInTheDocument());
    expect(mockExecute).toHaveBeenCalledWith("c1", PAYLOAD);
    expect(screen.getByTestId("result-panel")).toHaveAttribute("data-outcome", "success");
    expect(screen.getByText(/bet-123/)).toBeInTheDocument();
  });

  it("shows failure result panel with failureReason", async () => {
    mockExecute.mockResolvedValueOnce({ status: "failure", failureReason: "LOGIN_FAILED" });
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByTestId("confirm-submit-button"));
    await waitFor(() => expect(screen.getByTestId("result-panel")).toBeInTheDocument());
    expect(screen.getByTestId("result-panel")).toHaveAttribute("data-outcome", "failure");
    expect(screen.getByText(/LOGIN_FAILED/)).toBeInTheDocument();
  });

  it("shows partial result panel in yellow", async () => {
    mockExecute.mockResolvedValueOnce({ status: "partial" });
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByTestId("confirm-submit-button"));
    await waitFor(() => expect(screen.getByTestId("result-panel")).toBeInTheDocument());
    expect(screen.getByTestId("result-panel")).toHaveAttribute("data-outcome", "partial");
    expect(screen.getByTestId("result-panel")).toHaveStyle({ backgroundColor: "#fef9c3" });
  });

  it("shows error panel on network error", async () => {
    mockExecute.mockRejectedValueOnce(new Error("executeBbaBet failed: 503 Service Unavailable"));
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByTestId("confirm-submit-button"));
    await waitFor(() => expect(screen.getByTestId("error-panel")).toBeInTheDocument());
    expect(screen.getByText(/503/)).toBeInTheDocument();
  });

  it("shows idempotency warning within 60s of last submit", async () => {
    mockExecute.mockResolvedValueOnce({ status: "success" });
    render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId("place-bet-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByTestId("confirm-submit-button"));
    await waitFor(() => expect(screen.getByTestId("result-panel")).toBeInTheDocument());
    expect(screen.getByTestId("place-bet-button")).toBeDisabled();
    expect(screen.getByTestId("idempotency-warning")).toBeInTheDocument();
  });

  it("snapshot", () => {
    const { asFragment } = render(
      <BbaMemoryExecuteBetPanel companyId="c1" payload={PAYLOAD} betSummary={SUMMARY} />,
      { wrapper: makeWrapper() },
    );
    expect(asFragment().textContent).toMatchInlineSnapshot(`"Place Bet"`);
  });
});
