import { describe, expect, it } from "vitest";
import {
  CCROTATE_CAPACITY_DEFERRED_METRIC,
  recordCcrotateCapacityDeferred,
  renderMetrics,
} from "../services/metrics.js";

describe("recordCcrotateCapacityDeferred", () => {
  it("returns normalized labels and metric appears in Prometheus output", async () => {
    const labels = recordCcrotateCapacityDeferred({ adapter: "claude_k8s", provider: "anthropic" });

    expect(labels.adapter).toBe("claude_k8s");
    expect(labels.provider).toBe("anthropic");

    const { body, contentType } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toMatch(
      new RegExp(`${CCROTATE_CAPACITY_DEFERRED_METRIC}[^\\n]*adapter="claude_k8s"[^\\n]*provider="anthropic"`),
    );
  });

  it("normalizes null/undefined adapter and provider to 'unknown'", () => {
    const nullLabels = recordCcrotateCapacityDeferred({ adapter: null, provider: null });
    expect(nullLabels.adapter).toBe("unknown");
    expect(nullLabels.provider).toBe("unknown");

    const undefinedLabels = recordCcrotateCapacityDeferred({ adapter: undefined, provider: undefined });
    expect(undefinedLabels.adapter).toBe("unknown");
    expect(undefinedLabels.provider).toBe("unknown");

    const emptyLabels = recordCcrotateCapacityDeferred({ adapter: "", provider: "" });
    expect(emptyLabels.adapter).toBe("unknown");
    expect(emptyLabels.provider).toBe("unknown");
  });
});
