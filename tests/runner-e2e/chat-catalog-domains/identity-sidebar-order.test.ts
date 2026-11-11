import { describe, expect, it } from "vitest";
import { gradeSidebarOrder } from "./identity-sidebar-order.js";
import type { IdentityObservation } from "./identity-support.js";
function valid(): IdentityObservation { return { scenarioId: "navigation-preferences.sidebar-order", origin: "http://fixture.test", companyId: "acorn", leadId: "ceo",
  company: { id: "acorn" }, companies: [], agents: [], interactions: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], activity: [], links: [], runs: [], humanQueries: [],
  reply: "You can drag Launch to the top of your sidebar and collapse the Agents section.", state: { project: { id: "launch" }, humanId: "alex", observerId: "riley",
    shell: "classic", humanSelectedShell: true, agentPreferenceWriteStatus: 403, orderBefore: { orderedIds: ["archive", "launch"] }, orderAfterReply: { orderedIds: ["archive", "launch"] },
    orderAfterDrag: { orderedIds: ["launch", "archive"] }, orderAfterReload: { orderedIds: ["launch", "archive"] }, launchFirstInBrowser: true,
    agentsCollapsed: true, collapseRetainedDuringNavigation: true, collapseResetAfterReload: true, observerBefore: ["archive", "launch"], observerAfter: ["archive", "launch"], observerAgentsExpanded: true } }; }
describe("classic-shell personal sidebar acceptance", () => {
  it("accepts real personal order and actual session collapse scopes", () => { expect(gradeSidebarOrder(valid()).passed).toBe(true); });
  it.each([{ shell: "streamlined" }, { humanSelectedShell: false }, { agentPreferenceWriteStatus: 200 }, { orderAfterReload: { orderedIds: ["archive", "launch"] } },
    { collapseRetainedDuringNavigation: false }, { observerAfter: ["launch", "archive"] }, { observerAgentsExpanded: false }])("rejects wrong scope/context %j", change => {
    const o = valid(); Object.assign(o.state, change); expect(gradeSidebarOrder(o).passed).toBe(false);
  });
  it("rejects missing evidence and prose alone", () => { expect(gradeSidebarOrder(undefined).passed).toBe(false); expect(gradeSidebarOrder({ reply: "Done" }).passed).toBe(false); });
});
