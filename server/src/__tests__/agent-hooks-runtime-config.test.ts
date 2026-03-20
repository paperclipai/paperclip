import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeConfigForCreate,
  normalizeRuntimeConfigForPatch,
  runtimeConfigHooksDiffer,
} from "../routes/agent-hooks-runtime-config.js";

describe("agent hooks runtimeConfig normalisation", () => {
  it("rejects hook configuration from non-board create flows", () => {
    expect(() =>
      normalizeRuntimeConfigForCreate({
        runtimeConfig: {
          hooks: {
            rules: [],
          },
        },
        allowHooksConfig: false,
      }),
    ).toThrowError("Only board can configure agent hooks");
  });

  it("preserves existing hooks when a non-board patch updates other runtime settings", () => {
    const next = normalizeRuntimeConfigForPatch({
      runtimeConfig: {
        heartbeat: {
          intervalSec: 300,
        },
      },
      existingRuntimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowedAgentRefs: ["CTO"],
          },
          rules: [
            {
              id: "wake-cto",
              event: "heartbeat.run.succeeded",
              actions: [
                {
                  type: "wake_agent",
                  agentRefs: ["CTO"],
                },
              ],
            },
          ],
        },
      },
      allowHooksConfig: false,
    });

    expect(next).toMatchObject({
      heartbeat: {
        intervalSec: 300,
      },
      hooks: {
        enabled: true,
        permissions: {
          allowedAgentRefs: ["CTO"],
        },
      },
    });
  });

  it("rejects explicit non-board hook edits on patch", () => {
    expect(() =>
      normalizeRuntimeConfigForPatch({
        runtimeConfig: {
          hooks: {
            enabled: false,
          },
        },
        existingRuntimeConfig: {
          hooks: {
            enabled: true,
            permissions: {
              allowedAgentRefs: ["CTO"],
            },
            rules: [],
          },
        },
        allowHooksConfig: false,
      }),
    ).toThrowError("Only board can modify agent hook configuration");
  });

  it("canonicalises board-managed hook configs with schema defaults", () => {
    const next = normalizeRuntimeConfigForCreate({
      runtimeConfig: {
        hooks: {
          rules: [
            {
              id: "notify",
              event: "heartbeat.run.finished",
              actions: [
                {
                  type: "webhook",
                  url: "https://example.test/hook",
                },
              ],
            },
          ],
        },
      },
      allowHooksConfig: true,
    });

    expect(next).toEqual({
      hooks: {
        enabled: true,
        permissions: {
          allowCommand: false,
          allowWebhook: false,
          allowIssueAssignment: false,
          allowedAgentRefs: [],
        },
        rules: [
          {
            id: "notify",
            enabled: true,
            event: "heartbeat.run.finished",
            actions: [
              {
                type: "webhook",
                url: "https://example.test/hook",
                method: "POST",
                headers: {},
                body: {},
                timeoutMs: 10000,
              },
            ],
          },
        ],
      },
    });
  });

  it("compares hook configs using canonical defaults", () => {
    expect(
      runtimeConfigHooksDiffer(
        {
          hooks: {
            rules: [
              {
                id: "notify",
                event: "heartbeat.run.finished",
                actions: [
                  {
                    type: "webhook",
                    url: "https://example.test/hook",
                  },
                ],
              },
            ],
          },
        },
        {
          hooks: {
            enabled: true,
            permissions: {
              allowCommand: false,
              allowWebhook: false,
              allowIssueAssignment: false,
              allowedAgentRefs: [],
            },
            rules: [
              {
                id: "notify",
                enabled: true,
                event: "heartbeat.run.finished",
                actions: [
                  {
                    type: "webhook",
                    url: "https://example.test/hook",
                    method: "POST",
                    headers: {},
                    body: {},
                    timeoutMs: 10000,
                  },
                ],
              },
            ],
          },
        },
      ),
    ).toBe(false);

    expect(
      runtimeConfigHooksDiffer(
        {
          hooks: {
            rules: [
              {
                id: "notify",
                event: "heartbeat.run.finished",
                actions: [
                  {
                    type: "webhook",
                    url: "https://example.test/hook",
                  },
                ],
              },
            ],
          },
        },
        {
          hooks: {
            rules: [
              {
                id: "notify",
                event: "heartbeat.run.finished",
                actions: [
                  {
                    type: "webhook",
                    url: "https://example.test/other-hook",
                  },
                ],
              },
            ],
          },
        },
      ),
    ).toBe(true);
  });
});
