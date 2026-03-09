import { describe, expect, it } from "vitest";
import claudeQuotaManifest from "../../../packages/plugins/examples/plugin-claude-quota-launcher-example/src/manifest.js";
import githubManifest from "../../../packages/plugins/examples/plugin-github-issues-example/src/manifest.js";
import slackManifest from "../../../packages/plugins/examples/plugin-slack-notifier-example/src/manifest.js";
import customAdapterManifest from "../../../packages/plugins/examples/plugin-custom-agent-adapter-example/src/manifest.js";
import entityTabsManifest from "../../../packages/plugins/examples/plugin-entity-tabs-example/src/manifest.js";
import helloWorldManifest from "../../../packages/plugins/examples/plugin-hello-world-example/src/manifest.js";
import fileBrowserManifest from "../../../packages/plugins/examples/plugin-file-browser-example/src/manifest.js";
import mainTabManifest from "../../../packages/plugins/examples/plugin-main-tab-example/src/manifest.js";
import ntfyManifest from "../../../packages/plugins/examples/plugin-ntfy-notifier-example/src/manifest.js";
import pageManifest from "../../../packages/plugins/examples/plugin-page-example/src/manifest.js";
import scheduledJobManifest from "../../../packages/plugins/examples/plugin-scheduled-job-example/src/manifest.js";
import sidebarModalManifest from "../../../packages/plugins/examples/plugin-sidebar-modal-example/src/manifest.js";
import toolsManifest from "../../../packages/plugins/examples/plugin-tools-example/src/manifest.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("first-party example plugin manifests", () => {
  const validator = pluginManifestValidator();
  const capabilityValidator = pluginCapabilityValidator();
  const manifests = [
    claudeQuotaManifest,
    customAdapterManifest,
    entityTabsManifest,
    fileBrowserManifest,
    githubManifest,
    helloWorldManifest,
    mainTabManifest,
    ntfyManifest,
    pageManifest,
    scheduledJobManifest,
    sidebarModalManifest,
    slackManifest,
    toolsManifest,
  ];

  function parseOrThrow(manifest: (typeof manifests)[number]) {
    const parsed = validator.parse(manifest);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.errors, null, 2));
    }
    return parsed.manifest;
  }

  it("parses and validates all example manifests", () => {
    for (const manifest of manifests) {
      const parsedManifest = parseOrThrow(manifest);

      const capabilities = capabilityValidator.validateManifestCapabilities(parsedManifest);
      expect(capabilities.allowed).toBe(true);
      expect(capabilities.missing).toEqual([]);
    }
  });

  it("includes the expected first-party example plugin ids", () => {
    const ids = manifests.map((manifest) => manifest.id);
    expect(ids).toEqual([
      "paperclip.claude-quota-launcher-example",
      "paperclip.custom-agent-adapter-reference",
      "paperclip.entity-tabs-example",
      "paperclip-file-browser-example",
      "paperclip.github-issues",
      "paperclip.hello-world-example",
      "paperclip.main-tab-example",
      "paperclip.ntfy-notifier",
      "paperclip.page-example",
      "paperclip.scheduled-job-example",
      "paperclip.sidebar-modal-example",
      "paperclip.slack-notifier",
      "paperclip.tools-example",
    ]);
  });

  it("requests only required capabilities for each reference implementation", () => {
    expect(parseOrThrow(claudeQuotaManifest).capabilities).toEqual([
      "ui.action.register",
      "http.outbound",
    ]);

    expect(parseOrThrow(customAdapterManifest).capabilities).toEqual([
      "events.subscribe",
      "events.emit",
      "agent.tools.register",
      "http.outbound",
      "secrets.read-ref",
      "plugin.state.write",
      "activity.log.write",
    ]);

    expect(parseOrThrow(entityTabsManifest).capabilities).toEqual([
      "ui.detailTab.register",
    ]);

    expect(parseOrThrow(fileBrowserManifest).capabilities).toEqual([
      "ui.sidebar.register",
      "ui.detailTab.register",
      "projects.read",
      "project.workspaces.read",
    ]);

    expect(parseOrThrow(githubManifest).capabilities).toEqual([
      "events.subscribe",
      "jobs.schedule",
      "agent.tools.register",
      "http.outbound",
      "secrets.read-ref",
      "plugin.state.write",
      "activity.log.write",
    ]);

    expect(parseOrThrow(slackManifest).capabilities).toEqual([
      "events.subscribe",
      "http.outbound",
      "secrets.read-ref",
      "plugin.state.write",
      "activity.log.write",
      "metrics.write",
    ]);

    expect(parseOrThrow(helloWorldManifest).capabilities).toEqual(["ui.dashboardWidget.register"]);

    expect(parseOrThrow(mainTabManifest).capabilities).toEqual([
      "ui.detailTab.register",
    ]);

    expect(parseOrThrow(ntfyManifest).capabilities).toEqual([
      "events.subscribe",
      "http.outbound",
      "secrets.read-ref",
      "plugin.state.write",
      "activity.log.write",
      "metrics.write",
    ]);

    expect(parseOrThrow(pageManifest).capabilities).toEqual([
      "ui.page.register",
    ]);

    expect(parseOrThrow(scheduledJobManifest).capabilities).toEqual([
      "jobs.schedule",
      "plugin.state.read",
      "plugin.state.write",
      "metrics.write",
    ]);

    expect(parseOrThrow(sidebarModalManifest).capabilities).toEqual([
      "ui.sidebar.register",
    ]);

    expect(parseOrThrow(toolsManifest).capabilities).toEqual([
      "agent.tools.register",
      "activity.log.write",
    ]);
  });
});
