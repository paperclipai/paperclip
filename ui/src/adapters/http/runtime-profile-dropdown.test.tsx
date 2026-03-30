// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HttpConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";
import { TooltipProvider } from "../../components/ui/tooltip";

function buildProps(
  runtimeProfiles: AdapterConfigFieldsProps["runtimeProfiles"],
): AdapterConfigFieldsProps {
  return {
    mode: "create",
    isCreate: true,
    adapterType: "http",
    values: {
      adapterType: "http",
      cwd: "",
      instructionsFilePath: "",
      promptTemplate: "",
      model: "",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "http://127.0.0.1:8000/webhook",
      httpRuntimeProfile: "http+crewai",
      httpRuntimeHeader: "CrewAI",
      bootstrapPrompt: "",
      payloadTemplateJson: "",
      workspaceStrategyType: "",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
      maxTurnsPerRun: 6,
      heartbeatEnabled: true,
      intervalSec: 300,
    },
    set: () => {},
    config: {},
    eff: (_group, _field, original) => original,
    mark: () => {},
    models: [],
    runtimeProfiles,
  };
}

describe("HttpConfigFields runtime profile dropdown", () => {
  it("renders registry-provided runtime profile options", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HttpConfigFields
          {...buildProps([
            { id: "http+crewai", label: "HTTP + CrewAI", framework: "CrewAI" },
            { id: "http+swarm", label: "HTTP + Swarm", framework: "Swarm", defaultHeaderValue: "Swarm" },
          ])}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("HTTP + CrewAI");
    expect(html).toContain("HTTP + Swarm");
  });
});
