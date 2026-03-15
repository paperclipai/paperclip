import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOpenClawGatewayConfig } from "@paperclipai/adapter-openclaw-gateway/ui";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OpenClawGatewayConfigFields } from "./config-fields";

describe("OpenClawGatewayConfigFields", () => {
  it("renders the gateway token input during agent creation", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <OpenClawGatewayConfigFields
          mode="create"
          isCreate={true}
          adapterType="openclaw_gateway"
          values={{
            ...defaultCreateValues,
            adapterType: "openclaw_gateway",
            url: "ws://127.0.0.1:18789",
          }}
          set={() => {}}
          config={{}}
          eff={(_group, _field, original) => original}
          mark={() => {}}
          models={[]}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("Gateway auth token (x-openclaw-token)");
    expect(html).toContain("Paperclip API URL override");
    expect(html).toContain("Wait timeout (ms)");
  });
});

describe("buildOpenClawGatewayConfig", () => {
  it("serializes the create-form token into the required header map", () => {
    const config = buildOpenClawGatewayConfig({
      ...defaultCreateValues,
      adapterType: "openclaw_gateway",
      url: "ws://127.0.0.1:18789",
      openClawGatewayToken: "gateway-token-1234567890",
      openClawPaperclipApiUrl: "https://paperclip.example",
      openClawRole: "operator",
      openClawScopes: "operator.admin, operator.read",
      openClawWaitTimeoutMs: "45000",
      openClawSessionKeyStrategy: "run",
    });

    expect(config).toEqual({
      url: "ws://127.0.0.1:18789",
      headers: { "x-openclaw-token": "gateway-token-1234567890" },
      paperclipApiUrl: "https://paperclip.example",
      timeoutSec: 120,
      waitTimeoutMs: 45000,
      sessionKeyStrategy: "run",
      role: "operator",
      scopes: ["operator.admin", "operator.read"],
    });
  });

  it("trims pasted gateway urls and omits whitespace-only values", () => {
    const normalizedConfig = buildOpenClawGatewayConfig({
      ...defaultCreateValues,
      adapterType: "openclaw_gateway",
      url: "  ws://127.0.0.1:18789  ",
    });
    const blankConfig = buildOpenClawGatewayConfig({
      ...defaultCreateValues,
      adapterType: "openclaw_gateway",
      url: "   ",
    });

    expect(normalizedConfig).toMatchObject({
      url: "ws://127.0.0.1:18789",
    });
    expect(blankConfig).not.toHaveProperty("url");
  });

  it("preserves fixed-session overrides from the create form", () => {
    const config = buildOpenClawGatewayConfig({
      ...defaultCreateValues,
      adapterType: "openclaw_gateway",
      url: "ws://127.0.0.1:18789",
      openClawSessionKeyStrategy: "fixed",
      openClawSessionKey: "paperclip-fixed",
    });

    expect(config).toMatchObject({
      sessionKeyStrategy: "fixed",
      sessionKey: "paperclip-fixed",
    });
  });
});
