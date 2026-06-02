// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../context/ThemeContext";
import { OpenClawPairingCard } from "./AgentDetail";

describe("OpenClawPairingCard", () => {
  it("shows pairing-required heading and message", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <OpenClawPairingCard
          gatewayUrl={null}
          onRetry={vi.fn()}
          isRetrying={false}
          retryError={null}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Device pairing required");
    expect(html).toContain("not yet approved");
    expect(html).toContain("Retry after approve");
  });

  it("shows gateway URL and CLI command when gatewayUrl provided", () => {
    const url = "wss://example.com/gateway";
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <OpenClawPairingCard
          gatewayUrl={url}
          onRetry={vi.fn()}
          isRetrying={false}
          retryError={null}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Gateway URL:");
    expect(html).toContain(url);
    expect(html).toContain("openclaw devices approve --latest --url");
    expect(html).toContain(url);
  });

  it("hides URL section when gatewayUrl is null", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <OpenClawPairingCard
          gatewayUrl={null}
          onRetry={vi.fn()}
          isRetrying={false}
          retryError={null}
        />
      </ThemeProvider>,
    );

    expect(html).not.toContain("Gateway URL:");
    expect(html).not.toContain("openclaw devices approve");
  });

  it("shows Retrying… label while isRetrying", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <OpenClawPairingCard
          gatewayUrl={null}
          onRetry={vi.fn()}
          isRetrying={true}
          retryError={null}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Retrying");
    expect(html).not.toContain("Retry after approve");
  });

  it("renders retryError message when present", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <OpenClawPairingCard
          gatewayUrl={null}
          onRetry={vi.fn()}
          isRetrying={false}
          retryError="Agent wakeup rejected"
        />
      </ThemeProvider>,
    );

    expect(html).toContain("Agent wakeup rejected");
  });
});
