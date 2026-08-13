import { describe, expect, it } from "vitest";
import type { WorkflowPhase, WorkflowRunDetail } from "@paperclipai/shared";
import { buildWorkflowBehaviorAgents, buildWorkflowTelemetryPhases } from "./workflow-behavior";

function phase(input: Partial<WorkflowPhase> & Pick<WorkflowPhase, "phaseKey" | "label" | "kind">): WorkflowPhase {
  return {
    id: `${input.phaseKey}-id`,
    companyId: "company-1",
    workflowRunId: "run-1",
    ordinal: 0,
    status: "succeeded",
    metadata: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...input,
  };
}

describe("buildWorkflowBehaviorAgents", () => {
  it("normalizes correlated telemetry spans into agent and tool phases", () => {
    const base = {
      schema: "bizbox.telemetry/v1" as const,
      companyId: "company-1",
      workflowRunId: "run-1",
      parentSpanId: null,
      actor: { kind: "agent" as const, name: "grounding_agent" },
      operation: { kind: "agent" as const, name: "grounding_agent" },
      status: "running" as const,
      attributes: { model: "gemini", configuredTools: ["partnerpal"] },
      error: null,
      createdAt: "2026-08-12T00:00:00.000Z",
    };
    const phases = buildWorkflowTelemetryPhases([
      {
        ...base,
        id: "row-1",
        event: "operation.started",
        eventId: "evt-1",
        spanId: "agent-1",
        sequence: 1,
        timestamp: "2026-08-12T00:00:00.000Z",
        input: { prompt: "Find a partner" },
      },
      {
        ...base,
        id: "row-2",
        event: "operation.started",
        eventId: "evt-2",
        spanId: "tool-1",
        parentSpanId: "agent-1",
        sequence: 2,
        timestamp: "2026-08-12T00:00:01.000Z",
        actor: { kind: "tool", name: "partnerpal" },
        operation: { kind: "tool", name: "partnerpal" },
        input: { query: "campaign ideas" },
      },
      {
        ...base,
        id: "row-3",
        event: "operation.completed",
        eventId: "evt-3",
        spanId: "tool-1",
        parentSpanId: "agent-1",
        sequence: 3,
        timestamp: "2026-08-12T00:00:02.000Z",
        actor: { kind: "tool", name: "partnerpal" },
        operation: { kind: "tool", name: "partnerpal" },
        status: "succeeded",
        output: { matches: 1 },
      },
    ]);

    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ kind: "agent", status: "running" });
    expect(phases[1]).toMatchObject({
      kind: "tool",
      status: "succeeded",
      metadata: expect.objectContaining({
        parentKey: "telemetry:agent-1",
        runtimeToolInput: { query: "campaign ideas" },
        runtimeToolOutput: { matches: 1 },
      }),
    });
  });

  it("separates run input, system instructions, and actual ADK tool calls", () => {
    const phases = [
      phase({
        phaseKey: "writer",
        label: "Writer",
        kind: "agent",
        metadata: {
          agentName: "Writer",
          systemPrompt: "Write a concise brief.",
        },
      }),
      phase({
        phaseKey: "lookup",
        label: "lookup_campaign",
        kind: "tool",
        metadata: { parentKey: "writer" },
      }),
    ];
    const run = {
      inputMarkdown: "Summarize campaign 42",
      consoleEntries: [{
        ts: "2026-08-10T00:00:00.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          author: "Writer",
          content: {
            role: "model",
            parts: [{ functionCall: { id: "call-1", name: "lookup_campaign", args: { id: 42 } } }],
          },
        }).slice(0, 40),
      }, {
        ts: "2026-08-10T00:00:01.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          author: "Writer",
          content: {
            role: "model",
            parts: [{ functionCall: { id: "call-1", name: "lookup_campaign", args: { id: 42 } } }],
          },
        }).slice(40)}\n${JSON.stringify({
          author: "Writer",
          content: {
            role: "model",
            parts: [{ functionResponse: { id: "call-1", name: "lookup_campaign", response: { found: true } } }],
          },
        })}\n`,
      }],
    } as WorkflowRunDetail;

    expect(buildWorkflowBehaviorAgents(run, phases)).toEqual([
      expect.objectContaining({
        name: "Writer",
        prompt: "Summarize campaign 42",
        promptSource: "run_input",
        systemPrompt: "Write a concise brief.",
        model: null,
        configuredTools: ["lookup_campaign"],
        tools: [expect.objectContaining({
          name: "lookup_campaign",
          input: { id: 42 },
          output: { found: true },
        })],
        dataSources: [expect.objectContaining({
          name: "lookup_campaign",
          status: "queried",
          query: { id: 42 },
          outcome: { found: true },
        })],
      }),
    ]);
  });

  it("retains every user-text part from ADK events for an agent prompt", () => {
    const run = {
      consoleEntries: [{
        ts: "2026-08-10T00:00:00.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          author: "Writer",
          content: {
            role: "user",
            parts: [{ text: "Use the July submissions." }, { text: "Keep the Citro voice." }],
          },
        })}\n${JSON.stringify({
          author: "Writer",
          content: {
            role: "user",
            parts: [{ text: "Return one ready-to-publish post." }],
          },
        })}\n`,
      }],
    } as WorkflowRunDetail;

    const agents = buildWorkflowBehaviorAgents(run, [
      phase({ phaseKey: "writer", label: "Writer", kind: "agent" }),
    ]);

    expect(agents[0]).toMatchObject({
      promptSource: "adk_event",
      prompt: "Use the July submissions.\n\nKeep the Citro voice.\n\nReturn one ready-to-publish post.",
    });
  });

  it("shows the workflow handoff only on the entry agent", () => {
    const handoff = "Workflow: Instagram Social CMS\n\nInput:\nCreate an Instagram post.";
    const agents = buildWorkflowBehaviorAgents({
      inputMarkdown: "Create an Instagram post.",
      consoleEntries: [],
    } as unknown as WorkflowRunDetail, [
      phase({
        phaseKey: "intake",
        label: "platform_intake_agent",
        kind: "agent",
        metadata: { runtimeAgent: true, prompt: handoff },
      }),
      phase({
        phaseKey: "community",
        label: "community_content_synthesis_agent",
        kind: "agent",
        metadata: { runtimeAgent: true, prompt: handoff },
      }),
      phase({
        phaseKey: "community-source",
        label: "social_conversation_analysis",
        kind: "tool",
        metadata: {
          parentKey: "community",
          runtimeToolName: "social_conversation_analysis",
          runtimeToolId: "social-conversations-1",
          runtimeToolInput: { period: "last 3 months" },
          runtimeToolOutput: { findings: ["aspirational goals"] },
        },
      }),
    ]);

    expect(agents[0]).toMatchObject({
      prompt: handoff,
      promptSource: "workflow_handoff",
    });
    expect(agents[1]).toMatchObject({
      prompt: null,
      promptSource: "unavailable",
      dataSources: [expect.objectContaining({
        name: "social_conversation_analysis",
        status: "queried",
        query: { period: "last 3 months" },
        outcome: { findings: ["aspirational goals"] },
      })],
    });
  });

  it("maps handoff telemetry to the named child agent", () => {
    const phases = buildWorkflowTelemetryPhases([
      {
        id: "handoff-row",
        companyId: "company-1",
        workflowRunId: "run-1",
        schema: "bizbox.telemetry/v1",
        event: "operation.started",
        eventId: "handoff-event",
        spanId: "handoff-span",
        parentSpanId: null,
        sequence: 1,
        timestamp: "2026-08-13T00:00:00.000Z",
        actor: { kind: "workflow", name: "Instagram Social CMS" },
        operation: { kind: "agent", name: "handoff:community_content_synthesis_agent" },
        status: "running",
        input: { prompt: "Use the social-conversation findings to draft the hidden-words post." },
        createdAt: "2026-08-13T00:00:00.000Z",
      },
      {
        id: "agent-row",
        companyId: "company-1",
        workflowRunId: "run-1",
        schema: "bizbox.telemetry/v1",
        event: "operation.started",
        eventId: "agent-event",
        spanId: "agent-span",
        parentSpanId: "handoff-span",
        sequence: 2,
        timestamp: "2026-08-13T00:00:01.000Z",
        actor: { kind: "agent", name: "community_content_synthesis_agent" },
        operation: { kind: "agent", name: "community_content_synthesis_agent" },
        status: "running",
        createdAt: "2026-08-13T00:00:01.000Z",
      },
    ]);

    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ kind: "phase", metadata: { handoffTarget: "community_content_synthesis_agent" } });
    expect(buildWorkflowBehaviorAgents(null, phases)).toEqual([
      expect.objectContaining({
        name: "community_content_synthesis_agent",
        prompt: "Use the social-conversation findings to draft the hidden-words post.",
        promptSource: "telemetry_handoff",
      }),
    ]);
  });

  it("accepts a completed-only handoff span with a structured payload", () => {
    const phases = buildWorkflowTelemetryPhases([{
      id: "handoff-completed-row",
      companyId: "company-1",
      workflowRunId: "run-1",
      schema: "bizbox.telemetry/v1",
      event: "operation.completed",
      eventId: "handoff-completed-event",
      spanId: "handoff-completed-span",
      parentSpanId: null,
      sequence: 1,
      timestamp: "2026-08-13T00:00:00.000Z",
      actor: { kind: "workflow", name: "Instagram Social CMS" },
      operation: { kind: "agent", name: "handoff:community_content_synthesis_agent" },
      status: "succeeded",
      input: { handoff: { content: "Use the social-analysis evidence, then write the game post." } },
      createdAt: "2026-08-13T00:00:00.000Z",
    }]);

    expect(buildWorkflowBehaviorAgents(null, [
      ...phases,
      phase({ phaseKey: "community", label: "community_content_synthesis_agent", kind: "agent" }),
    ])).toContainEqual(expect.objectContaining({
      name: "community_content_synthesis_agent",
      prompt: "Use the social-analysis evidence, then write the game post.",
      promptSource: "telemetry_handoff",
    }));
  });

  it("shows live runtime metadata before an agent finishes", () => {
    const agents = buildWorkflowBehaviorAgents({
      inputMarkdown: "Create a Facebook post",
      consoleEntries: [],
      model: null,
    } as unknown as WorkflowRunDetail, [
      phase({
        phaseKey: "agent-runtime:platform_intake_agent",
        label: "platform_intake_agent",
        kind: "agent",
        status: "running",
        metadata: {
          runtimeAgent: true,
          agentName: "platform_intake_agent",
          model: "bedrock/global.anthropic.claude-sonnet-4-6",
          prompt: "Create a Facebook post",
          systemPrompt: "Return a validated platform brief.",
          configuredTools: ["lookup_campaign"],
          output: { platform: "facebook", accepted: true },
        },
      }),
    ]);

    expect(agents[0]).toMatchObject({
      called: true,
      status: "running",
      model: "bedrock/global.anthropic.claude-sonnet-4-6",
      prompt: "Create a Facebook post",
      systemPrompt: "Return a validated platform brief.",
      configuredTools: ["lookup_campaign"],
      output: { platform: "facebook", accepted: true },
      dataSources: [expect.objectContaining({
        name: "lookup_campaign",
        status: "configured",
        query: null,
        outcome: null,
      })],
    });
  });

  it("extracts dynamically loaded skill bundles from the resolved system instruction", () => {
    const systemPrompt = `Write one Facebook post.\n\nFacebook skill:\n# SKILL.md\n\n---\nname: citro-social-write-facebook-post\ndescription: Write Facebook copy.\n---\n\n# Facebook writer\n\nUse supplied facts.\n\n---\n\n# REFERENCE.md\n\nReference details.\n\nCitro brand skill:\n# SKILL.md\n\n---\nname: citro-social-apply-citro-brand\ndescription: Apply the brand.\n---\n\n# Citro brand\n\nUse the Citro voice.`;
    const agents = buildWorkflowBehaviorAgents(null, [
      phase({
        phaseKey: "writer",
        label: "Writer",
        kind: "agent",
        metadata: { agentName: "Writer", systemPrompt },
      }),
    ]);

    expect(agents[0]?.skills).toEqual([
      expect.objectContaining({
        name: "citro-social-write-facebook-post",
        content: expect.stringContaining("Reference details."),
      }),
      expect.objectContaining({
        name: "citro-social-apply-citro-brand",
        content: expect.stringContaining("Use the Citro voice."),
      }),
    ]);
  });

  it("shows direct image-generation prompts and service call details", () => {
    const agents = buildWorkflowBehaviorAgents(null, [
      phase({
        phaseKey: "service-runtime:citro-studio-image:1",
        label: "Citro Studio image generation",
        kind: "agent",
        status: "succeeded",
        metadata: {
          runtimeAgent: true,
          agentName: "Citro Studio image generation",
          service: "Citro Studio / Databricks",
          prompt: "Create a realistic partnership image.",
          configuredTools: ["generate_image"],
          runtimeToolName: "generate_image",
          runtimeToolId: "image-1",
          runtimeToolInput: {
            prompt: "Create a realistic partnership image.",
            referenceImages: ["template.png"],
            visualStyle: "edit-mode",
            aspectRatio: "1:1",
            mode: "image-lite",
          },
          runtimeToolOutput: {
            savedPath: "/tmp/generated.png",
            contentType: "image/png",
            byteLength: 2048,
            jobId: "job-1",
          },
          output: {
            savedPath: "/tmp/generated.png",
            contentType: "image/png",
            byteLength: 2048,
            jobId: "job-1",
          },
        },
      }),
    ]);

    expect(agents[0]).toMatchObject({
      name: "Citro Studio image generation",
      service: "Citro Studio / Databricks",
      model: null,
      prompt: "Create a realistic partnership image.",
      promptSource: "runtime_service",
      output: expect.objectContaining({ jobId: "job-1", byteLength: 2048 }),
      tools: [expect.objectContaining({
        name: "generate_image",
        input: expect.objectContaining({ aspectRatio: "1:1", referenceImages: ["template.png"] }),
        output: expect.objectContaining({ jobId: "job-1", byteLength: 2048 }),
      })],
      dataSources: [expect.objectContaining({
        name: "generate_image",
        status: "queried",
        query: expect.objectContaining({ aspectRatio: "1:1" }),
        outcome: expect.objectContaining({ jobId: "job-1" }),
      })],
    });
  });

  it("nests compact grounding query tools under the agent that called them", () => {
    const run = {
      inputMarkdown: "Feature a July Citro UGC submission",
      consoleEntries: [{
        ts: "2026-08-12T00:00:00.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          event: "source_grounding.started",
          node: "social_media_grounding_agent",
          details: {
            platform: "instagram",
            sources: ["databricks_ugc_submissions"],
            month_of_ugc: "July",
            submission_platform: "CITRO",
          },
        })}\n${JSON.stringify({
          event: "source_grounding.finished",
          node: "social_media_grounding_agent",
          status: "ok",
          details: {
            platform: "instagram",
            sources: ["databricks_ugc_submissions"],
            matches: 25,
            provenance: 1,
          },
        })}\n`,
      }],
    } as WorkflowRunDetail;

    const agents = buildWorkflowBehaviorAgents(run, [
      phase({
        phaseKey: "agent:social_media_grounding_agent",
        label: "social_media_grounding_agent",
        kind: "agent",
        status: "idle",
        metadata: { agentName: "social_media_grounding_agent" },
      }),
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "social_media_grounding_agent",
      called: true,
      configuredTools: ["databricks_ugc_submissions"],
      tools: [expect.objectContaining({
        name: "databricks_ugc_submissions",
        input: {
          platform: "instagram",
          month_of_ugc: "July",
          submission_platform: "CITRO",
        },
        output: expect.objectContaining({ matches: 25, provenance: 1 }),
      })],
      dataSources: [expect.objectContaining({
        name: "databricks_ugc_submissions",
        status: "queried",
        query: {
          platform: "instagram",
          month_of_ugc: "July",
          submission_platform: "CITRO",
        },
        outcome: expect.objectContaining({ matches: 25, provenance: 1 }),
      })],
    });
  });

  it("does not duplicate a normalized tool query with compact grounding fallback", () => {
    const run = {
      consoleEntries: [{
        ts: "2026-08-12T00:00:01.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          event: "source_grounding.started",
          node: "social_media_grounding_agent",
          details: {
            sources: ["databricks_ugc_submissions"],
            platform: "instagram",
            month_of_ugc: null,
            submission_platform: "CITRO",
            requested_candidates: 5,
            limit: 25,
            mode: "multi_source_campaign",
          },
        })}\n${JSON.stringify({
          event: "source_grounding.finished",
          node: "social_media_grounding_agent",
          status: "ok",
          details: {
            matches: 5,
            items: [{ answer: "Save more but still enjoy life" }],
          },
        })}\n`,
      }],
    } as WorkflowRunDetail;

    const agents = buildWorkflowBehaviorAgents(run, [
      phase({
        phaseKey: "agent:social_media_grounding_agent",
        label: "social_media_grounding_agent",
        kind: "agent",
        metadata: {
          runtimeAgent: true,
          agentName: "social_media_grounding_agent",
        },
      }),
      phase({
        phaseKey: "tool:databricks-query",
        label: "databricks_ugc_submissions",
        kind: "tool",
        metadata: {
          runtimeCalled: true,
          parentKey: "agent:social_media_grounding_agent",
          runtimeToolName: "databricks_ugc_submissions",
          runtimeToolId: "databricks-query",
          runtimeToolInput: {
            limit: 25,
            month_of_ugc: "",
            source_platform: "CITRO",
          },
          runtimeToolOutput: {
            rows: [{ answer: "Save more but still enjoy life" }],
          },
        },
      }),
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0]?.tools).toHaveLength(1);
    expect(agents[0]?.dataSources).toEqual([
      expect.objectContaining({
        id: "tool-databricks-query",
        name: "databricks_ugc_submissions",
        status: "queried",
        query: {
          limit: 25,
          month_of_ugc: "",
          source_platform: "CITRO",
        },
      }),
    ]);
  });

  it("keeps additional compact queries when only one normalized call was captured", () => {
    const compactEvent = (ts: string, event: string, details: Record<string, unknown>) => ({
      ts,
      stream: "stdout" as const,
      chunk: `${JSON.stringify({
        event,
        node: "social_media_grounding_agent",
        status: event.endsWith("finished") ? "ok" : undefined,
        details,
      })}\n`,
    });
    const run = {
      consoleEntries: [
        compactEvent("2026-08-12T00:00:01.000Z", "source_grounding.started", {
          sources: ["databricks_ugc_submissions"],
          query: "first",
        }),
        compactEvent("2026-08-12T00:00:02.000Z", "source_grounding.finished", {
          matches: 1,
        }),
        compactEvent("2026-08-12T00:00:03.000Z", "source_grounding.started", {
          sources: ["databricks_ugc_submissions"],
          query: "second",
        }),
        compactEvent("2026-08-12T00:00:04.000Z", "source_grounding.finished", {
          matches: 2,
        }),
      ],
    } as WorkflowRunDetail;

    const agents = buildWorkflowBehaviorAgents(run, [
      phase({
        phaseKey: "agent:social_media_grounding_agent",
        label: "social_media_grounding_agent",
        kind: "agent",
        metadata: { runtimeAgent: true, agentName: "social_media_grounding_agent" },
      }),
      phase({
        phaseKey: "tool:databricks-query",
        label: "databricks_ugc_submissions",
        kind: "tool",
        metadata: {
          runtimeCalled: true,
          parentKey: "agent:social_media_grounding_agent",
          runtimeToolName: "databricks_ugc_submissions",
          runtimeToolId: "databricks-query",
          runtimeToolInput: { query: "first" },
          runtimeToolOutput: { matches: 1 },
        },
      }),
    ]);

    expect(agents[0]?.tools).toHaveLength(2);
    expect(agents[0]?.dataSources).toHaveLength(2);
    expect(agents[0]?.dataSources[1]).toMatchObject({
      name: "databricks_ugc_submissions",
      query: { query: "second" },
    });
  });

  it("shows the rich PartnerPal outcome emitted by compact grounding completion", () => {
    const run = {
      consoleEntries: [{
        ts: "2026-08-12T00:00:00.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          event: "source_grounding.started",
          node: "social_media_grounding_agent",
          details: { platform: "instagram", sources: ["partnerpal"], mode: "campaign_planning" },
        })}\n${JSON.stringify({
          event: "source_grounding.finished",
          node: "social_media_grounding_agent",
          status: "ok",
          details: { platform: "instagram", sources: ["partnerpal"], matches: 1 },
        })}\n${JSON.stringify({
          event: "source_grounding.completed",
          node: "instagram_grounding",
          status: "ok",
          details: {
            sources: ["partnerpal"],
            outcomes: {
              partnerpal: {
                status: "ok",
                query: "campaign activation ideas",
                matches: 1,
                items: [{ excerpt: "A practical campaign activation idea." }],
              },
            },
          },
        })}\n`,
      }],
    } as WorkflowRunDetail;

    const partnerpal = buildWorkflowBehaviorAgents(run, []).find((agent) => agent.name === "partnerpal");
    expect(partnerpal).toMatchObject({
      actorKind: "tool",
      called: true,
      tools: [expect.objectContaining({
        input: expect.objectContaining({ query: "campaign activation ideas" }),
        output: expect.objectContaining({
          matches: 1,
          items: [{ excerpt: "A practical campaign activation idea." }],
        }),
      })],
      dataSources: [expect.objectContaining({
        query: expect.objectContaining({ query: "campaign activation ideas" }),
        outcome: expect.objectContaining({
          items: [{ excerpt: "A practical campaign activation idea." }],
        }),
      })],
    });
  });

  it("lists run-mounted resources as available sources without claiming a query", () => {
    const agents = buildWorkflowBehaviorAgents({
      inputMarkdown: "Use the campaign resource",
      consoleEntries: [],
      contextSnapshot: {
        resourceVersions: [{
          resourceId: "resource-1",
          resourceKey: "campaign",
          requestedRef: "branch:main",
          resolvedRef: "main",
          commit: "abcdef123456",
          mountPath: "resources/campaign",
          published: true,
        }],
      },
    } as unknown as WorkflowRunDetail, [
      phase({ phaseKey: "writer", label: "Writer", kind: "agent" }),
    ]);

    expect(agents[0]?.dataSources).toContainEqual(expect.objectContaining({
      name: "campaign",
      kind: "resource",
      status: "available",
      query: expect.objectContaining({ mountPath: "resources/campaign" }),
      outcome: expect.objectContaining({ commit: "abcdef123456" }),
    }));
  });

  it("falls back to the final ADK model message for older captured runs", () => {
    const agents = buildWorkflowBehaviorAgents({
      inputMarkdown: "Draft a post",
      consoleEntries: [{
        ts: "2026-08-10T00:00:00.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({
          author: "Writer",
          content: { role: "model", parts: [{ text: "Final post copy" }] },
        })}\n`,
      }],
    } as WorkflowRunDetail, [
      phase({ phaseKey: "writer", label: "Writer", kind: "agent" }),
    ]);

    expect(agents[0]?.output).toBe("Final post copy");
  });

  it("does not invent a downstream agent prompt", () => {
    const agents = buildWorkflowBehaviorAgents(null, [
      phase({ phaseKey: "root", label: "Root", kind: "agent", status: "idle" }),
      phase({ phaseKey: "reviewer", label: "Reviewer", kind: "agent", status: "idle" }),
    ]);

    expect(agents[1]).toMatchObject({
      name: "Reviewer",
      prompt: null,
      promptSource: "unavailable",
      called: false,
    });
  });

  it("does not treat terminalized static agents as called without runtime evidence", () => {
    const agents = buildWorkflowBehaviorAgents({
      consoleEntries: [],
    } as unknown as WorkflowRunDetail, [
      phase({
        phaseKey: "facebook-editor",
        label: "facebook_post_edit_agent",
        kind: "agent",
        status: "succeeded",
        metadata: { agentName: "facebook_post_edit_agent" },
      }),
      phase({
        phaseKey: "instagram-writer",
        label: "instagram_post_writer_agent",
        kind: "agent",
        status: "succeeded",
        metadata: { agentName: "instagram_post_writer_agent", runtimeAgent: true },
      }),
    ]);

    expect(agents.map((agent) => ({ name: agent.name, called: agent.called }))).toEqual([
      { name: "facebook_post_edit_agent", called: false },
      { name: "instagram_post_writer_agent", called: true },
    ]);
  });
});
