/** Scenario/eval projection of the per-action protocol definitions. */
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";
import type { CapabilityOptionalCatalogGroup, CapabilitySemanticToolDescriptor } from "./capability-semantic-tool-types.js";
const descriptors = PAPERCLIP_PROTOCOL_ACTIONS.filter((action) => action.scenario !== null)
  .sort((left, right) => left.scenario!.order - right.scenario!.order)
  .map((action) => action.scenario!.descriptor as unknown as CapabilitySemanticToolDescriptor);
export const CAPABILITY_SEMANTIC_TOOL_CATALOG: readonly CapabilitySemanticToolDescriptor[] = Object.freeze(descriptors);
export const CAPABILITY_OPTIONAL_TOOL_CATALOGS: Readonly<Record<CapabilityOptionalCatalogGroup, readonly CapabilitySemanticToolDescriptor[]>> = Object.freeze({
  discovery: toolsInGroup("discovery"), delegation_dependencies: toolsInGroup("delegation_dependencies"), governance: toolsInGroup("governance"), cases: toolsInGroup("cases"), workspace_runtime: toolsInGroup("workspace_runtime"), routines: toolsInGroup("routines"), company_skills: toolsInGroup("company_skills"), secrets: toolsInGroup("secrets"), portability_admin: toolsInGroup("portability_admin"), test_escape_hatch: toolsInGroup("test_escape_hatch"),
});
export function capabilitySemanticTool(operationId: string): CapabilitySemanticToolDescriptor | undefined { return CAPABILITY_SEMANTIC_TOOL_CATALOG.find((tool) => tool.operationId === operationId); }
function toolsInGroup(group: CapabilityOptionalCatalogGroup): readonly CapabilitySemanticToolDescriptor[] { return Object.freeze(CAPABILITY_SEMANTIC_TOOL_CATALOG.filter((tool) => tool.optionalGroup === group)); }
