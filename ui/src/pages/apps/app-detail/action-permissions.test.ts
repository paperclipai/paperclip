import { describe, expect, it } from "vitest";
import { actionPermissionMutation } from "./action-permissions";

describe("actionPermissionMutation", () => {
  const enabled = new Set(["a", "b", "c"]);
  const askFirst = new Set(["b"]);

  it("sets every action in a group at once", () => {
    expect(actionPermissionMutation(["a", "b", "c"], "ask", enabled, askFirst)).toEqual({
      enabled: new Set(["a", "b", "c"]),
      askFirst: new Set(["a", "b", "c"]),
    });
    expect(actionPermissionMutation(["a", "b", "c"], "off", enabled, askFirst)).toEqual({
      enabled: new Set(),
      askFirst: new Set(),
    });
    expect(actionPermissionMutation(["a", "b", "c"], "allowed", new Set(), askFirst)).toEqual({
      enabled: new Set(["a", "b", "c"]),
      askFirst: new Set(),
    });
  });

  it("leaves actions outside the group alone", () => {
    expect(actionPermissionMutation(["a"], "off", enabled, askFirst)).toEqual({
      enabled: new Set(["b", "c"]),
      askFirst: new Set(["b"]),
    });
  });
});
