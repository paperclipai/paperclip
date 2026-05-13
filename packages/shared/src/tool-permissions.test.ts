import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_MCP_TOOL_POLICIES,
  classifyPaperclipApiRequestPolicy,
  getPaperclipMcpToolPolicy,
} from "./tool-permissions.js";

describe("tool permission registry", () => {
  it("classifies read-only MCP tools as no-side-effect with no approval gate", () => {
    expect(getPaperclipMcpToolPolicy("paperclipGetIssue")).toMatchObject({
      toolName: "paperclipGetIssue",
      actionRiskLevel: "no_side_effect",
      riskClass: "low",
      requiredApprovalGate: "none",
      requiresExplicitApproval: false,
    });
  });

  it("marks live runtime controls as explicit approval gated", () => {
    expect(getPaperclipMcpToolPolicy("paperclipControlIssueWorkspaceServices")).toMatchObject({
      toolName: "paperclipControlIssueWorkspaceServices",
      actionRiskLevel: "local_only",
      riskClass: "high",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
    });
  });

  it("marks destructive document restore operations as destructive", () => {
    expect(getPaperclipMcpToolPolicy("paperclipRestoreIssueDocumentRevision")).toMatchObject({
      actionRiskLevel: "destructive",
      riskClass: "high",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
    });
  });

  it("keeps the generic API escape hatch visible and explicitly gated", () => {
    expect(PAPERCLIP_MCP_TOOL_POLICIES.paperclipApiRequest).toMatchObject({
      toolName: "paperclipApiRequest",
      actionRiskLevel: "external_live",
      riskClass: "critical",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
    });
  });

  it("classifies generic GET requests as read-only", () => {
    expect(classifyPaperclipApiRequestPolicy("GET", "/issues/LET-125")).toMatchObject({
      actionRiskLevel: "no_side_effect",
      riskClass: "low",
      requiredApprovalGate: "none",
      requiresExplicitApproval: false,
    });

    expect(classifyPaperclipApiRequestPolicy("get", "//issues/LET-125/?include=summary#top")).toMatchObject({
      actionRiskLevel: "no_side_effect",
      riskClass: "low",
      requiredApprovalGate: "none",
      requiresExplicitApproval: false,
      pathPattern: "/issues/LET-125",
    });
  });

  it("default-denies unknown generic mutating requests", () => {
    expect(classifyPaperclipApiRequestPolicy("patch", "/some-new-admin-route?debug=true#fragment")).toMatchObject({
      category: "paperclip_write",
      actionRiskLevel: "paperclip_only",
      riskClass: "high",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
    });
  });

  it("classifies generic mutating runtime and secret requests as approval-gated", () => {
    expect(classifyPaperclipApiRequestPolicy("POST", "/execution-workspaces/ws-1/runtime-services/restart")).toMatchObject({
      category: "runtime_control",
      actionRiskLevel: "local_only",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
    });

    expect(classifyPaperclipApiRequestPolicy("DELETE", "/secret-provider-configs/vault-1")).toMatchObject({
      category: "secrets",
      actionRiskLevel: "destructive",
      requiredApprovalGate: "compliance",
      requiresExplicitApproval: true,
    });
  });
});
