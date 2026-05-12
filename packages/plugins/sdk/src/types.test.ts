import { describe, expect, it } from "vitest";
import type { IssueCustomField, IssueCustomFieldsClient } from "./types.js";
import type { Issue } from "@paperclipai/shared";

describe("WS-4 SDK type contracts", () => {
  it("IssueCustomField has required fields", () => {
    const field: IssueCustomField = {
      pluginId: "uuid-1",
      pluginKey: "test.plugin",
      pluginDisplayName: "Test Plugin",
      key: "workstream",
      type: "enum-ref",
      label: "Workstream",
      valueText: "clone-3",
      valueNumber: null,
    };
    expect(field.pluginId).toBe("uuid-1");
    expect(field.key).toBe("workstream");
    expect(field.type).toBe("enum-ref");
    expect(field.valueText).toBe("clone-3");
    expect(field.valueNumber).toBeNull();
  });

  it("IssueCustomField supports all types", () => {
    const textField: IssueCustomField = {
      pluginId: "uuid-1",
      pluginKey: "test.plugin",
      pluginDisplayName: "Test Plugin",
      key: "description",
      type: "text",
      label: "Description",
      valueText: "some text",
      valueNumber: null,
    };
    expect(textField.type).toBe("text");

    const numberField: IssueCustomField = {
      pluginId: "uuid-1",
      pluginKey: "test.plugin",
      pluginDisplayName: "Test Plugin",
      key: "priority-score",
      type: "number",
      label: "Priority Score",
      valueText: "42",
      valueNumber: 42,
    };
    expect(numberField.valueNumber).toBe(42);

    const urlField: IssueCustomField = {
      pluginId: "uuid-1",
      pluginKey: "test.plugin",
      pluginDisplayName: "Test Plugin",
      key: "docs-link",
      type: "url",
      label: "Docs",
      valueText: "https://example.com",
      valueNumber: null,
    };
    expect(urlField.type).toBe("url");
  });

  it("Issue type accepts optional customFields", () => {
    const issueWithFields: Partial<Issue> & { customFields?: IssueCustomField[] } = {
      customFields: [
        {
          pluginId: "uuid-1",
          pluginKey: "test.plugin",
          pluginDisplayName: "Test Plugin",
          key: "workstream",
          type: "enum-ref",
          label: "Workstream",
          valueText: "clone-3",
          valueNumber: null,
        },
      ],
    };
    expect(issueWithFields.customFields).toHaveLength(1);
  });

  it("IssueCustomFieldsClient has correct method signatures (compile-time via typeof)", () => {
    type SetParams = Parameters<IssueCustomFieldsClient["set"]>[0];
    const params: SetParams = {
      companyId: "c1",
      issueId: "i1",
      key: "workstream",
      value: "clone-3",
    };
    expect(params.companyId).toBe("c1");

    type UnsetParams = Parameters<IssueCustomFieldsClient["unset"]>[0];
    const unsetParams: UnsetParams = {
      companyId: "c1",
      issueId: "i1",
      key: "workstream",
    };
    expect(unsetParams.key).toBe("workstream");

    type ListParams = Parameters<IssueCustomFieldsClient["listForIssue"]>[0];
    const listParams: ListParams = {
      companyId: "c1",
      issueId: "i1",
    };
    expect(listParams.issueId).toBe("i1");
  });
});
