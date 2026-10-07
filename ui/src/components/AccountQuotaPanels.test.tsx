import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../lib/utils";
import { AccountQuotaPanels } from "./AccountQuotaPanels";

describe("account quota panels", () => {
  it("renders both accounts for one provider without merging their windows", () => {
    const html = renderToStaticMarkup(<AccountQuotaPanels accounts={[
      { provider: "openai", accountKey: "a", accountLabel: "Personal", ok: true, windows: [{ label: "Personal limit", usedPercent: 25, resetsAt: null, valueLabel: null }] },
      { provider: "openai", accountKey: "b", accountLabel: "Shared", ok: true, windows: [{ label: "Shared limit", usedPercent: 75, resetsAt: null, valueLabel: null }] },
    ]} />);
    expect(html).toContain("Personal limit");
    expect(html).toContain("Shared limit");
    expect(html).toContain("25% used");
    expect(html).toContain("75% used");
  });
  it("displays unknown utilization without inventing zero percent", () => {
    const html = renderToStaticMarkup(<AccountQuotaPanels accounts={[
      { provider: "openai", accountKey: "a", ok: true, windows: [{ label: "Credits", usedPercent: null, resetsAt: "2026-10-05T00:00:00Z", valueLabel: "$5 remaining" }] },
    ]} />);
    expect(html).toContain("$5 remaining");
    expect(html).toContain(`Resets ${formatDateTime("2026-10-05T00:00:00Z")}`);
    expect(html).not.toContain("0%");
    expect(html).not.toContain('role="progressbar"');
  });
});
