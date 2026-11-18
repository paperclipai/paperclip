import { describe, expect, it } from "vitest";
import { PAPERCLIP_ENUM_DESCRIPTIONS, type TelemetryEvent } from "@paperclipai/shared/telemetry";
import golden from "../services/posthog-direct/__fixtures__/loader-golden.json" with { type: "json" };
import { UNKNOWN_ENUM_FALLBACKS } from "../services/posthog-direct/enum-fallbacks.generated.js";
import {
  buildPostHogDirectEvent,
  resolveDistinctId,
} from "../services/posthog-direct/event-shape.js";

// The golden fixture is produced by running the telemetry backend's own ingest
// and loader on one collector envelope. Regenerate it with
// `node scripts/generate-posthog-direct-fixtures.mjs <telemetry-backend-dir>`.

const config = { stackId: "stack-123", environment: "staging" };
const meta = {
  app: golden.envelope.app,
  schemaVersion: golden.envelope.schemaVersion,
  installId: golden.envelope.installId,
  version: golden.envelope.version,
  ingestedAt: golden.ingestedAt,
};

type LoaderEvent = (typeof golden.loaderEvents)[number];

// The Cloud direct path emits the raw task id where the collector path emits
// its salted hash. Everything else in the event is the same input.
function directInput(event: (typeof golden.envelope.events)[number]): TelemetryEvent {
  const dimensions = { ...event.dimensions } as Record<string, string | number | boolean>;
  if (dimensions.task_id === golden.hashedTaskId) dimensions.task_id = golden.rawTaskId;
  return { name: event.name, occurredAt: event.occurredAt, dimensions };
}

describe("Cloud direct PostHog event shape", () => {
  const direct = golden.envelope.events.map((event) =>
    buildPostHogDirectEvent(directInput(event), undefined, meta, config),
  );
  const sent = direct.filter((event) => event !== null);

  it("drops exactly the events the backend quarantines", () => {
    expect(sent.map((event) => event!.event)).toEqual(golden.loaderEvents.map((event) => event.event));
    expect(direct.find((_, i) => golden.envelope.events[i]!.name === "question_response.delivery")).toBeNull();
  });

  it("matches the loader output except for the intended Cloud differences", () => {
    golden.loaderEvents.forEach((loader: LoaderEvent, index) => {
      const ours = sent[index]!;
      const inputDims = golden.envelope.events.find((e) => e.name === loader.event)!.dimensions as Record<string, unknown>;
      const hasPrivateRef = "task_id" in inputDims;

      // Same envelope-level fields; uuid differs only when the dimensions do.
      expect(ours.event).toBe(loader.event);
      expect(ours.timestamp).toBe(loader.timestamp);
      expect(ours.disableGeoip).toBe(loader.disableGeoip);
      expect(ours.sendFeatureFlags).toBe(loader.sendFeatureFlags);
      if (hasPrivateRef) expect(ours.uuid).not.toBe(loader.uuid);
      else expect(ours.uuid).toBe(loader.uuid);

      // Intended differences: real ids and Cloud workspace properties.
      const intended = {
        distinct_id: "workspace:stack-123",
        stack_id: "stack-123",
        environment: "staging",
        $groups: { workspace: "stack-123" },
        ...("agent_id" in inputDims ? { agent_id: inputDims.agent_id } : {}),
        ...(hasPrivateRef ? { task_id: golden.rawTaskId } : {}),
      };
      expect(ours.distinct_id).toBe("workspace:stack-123");
      expect(ours.properties).toEqual({ ...loader.properties, ...intended });
      // Key order matches too, so the stored property layout is identical.
      expect(Object.keys(ours.properties).slice(0, Object.keys(loader.properties).length - 2)).toEqual(
        Object.keys(loader.properties).filter((key) => key !== "distinct_id" && key !== "$process_person_profile"),
      );
    });
  });

  it("uses the acting user as distinct_id and links the browser session", () => {
    const event = buildPostHogDirectEvent(
      { name: "routine.created", occurredAt: "2026-11-17T11:58:06.000Z", dimensions: {} },
      { userId: "user-1", companyId: "company-1", sessionId: "sess-1", windowId: "win-1" },
      meta,
      config,
    )!;
    expect(event.distinct_id).toBe("user-1");
    expect(event.properties).toMatchObject({
      distinct_id: "user-1",
      user_id: "user-1",
      company_id: "company-1",
      $session_id: "sess-1",
      $window_id: "win-1",
      $groups: { workspace: "stack-123" },
    });
    expect(event.properties).not.toHaveProperty("$process_person_profile");
  });

  it("falls back to the workspace id without an acting user", () => {
    expect(resolveDistinctId(config, undefined)).toBe("workspace:stack-123");
    expect(resolveDistinctId(config, { companyId: "company-1", sessionId: "sess-1" })).toBe("workspace:stack-123");
    expect(resolveDistinctId(config, { userId: "user-9" })).toBe("user-9");
  });

  it("keeps every generated fallback rule tied to an enum in the shared contract", () => {
    const domains = PAPERCLIP_ENUM_DESCRIPTIONS as Record<string, Record<string, Record<string, string>>>;
    for (const [eventName, rules] of Object.entries(UNKNOWN_ENUM_FALLBACKS)) {
      for (const [key, rule] of Object.entries(rules)) {
        expect(Object.keys(domains[eventName]?.[key] ?? {}), `${eventName}.${key}`).toContain(rule.fallback);
      }
    }
  });
});
