import { expect, it } from "vitest";
import { projectRequestedRepositories } from "./internal-repositories.js";
const requested = [{ id: "42", fullName: "owned/qa" }];
const actual = { id: "42", fullName: "owned/qa", url: "https://github.com/owned/qa", connectionIds: ["actual", "unrelated-connection"], description: "metadata not needed in public observations" };
it("keeps only the actual requested repository tuple and current connection attribution", () => {
  expect(projectRequestedRepositories([actual, { ...actual, id: "99", fullName: "other/private", url: "https://github.com/other/private" }], requested, "actual"))
    .toEqual([{ id: "42", fullName: "owned/qa", url: "https://github.com/owned/qa", connectionIds: ["actual"] }]);
});
it("never rescues wrong IDs, names, URLs or foreign-connection discovery", () => {
  for (const delta of [{ id: "43" }, { fullName: "other/qa" }, { url: "https://foreign.invalid/owned/qa" }, { connectionIds: ["foreign"] }])
    expect(projectRequestedRepositories([{ ...actual, ...delta }], requested, "actual")).toEqual([]);
  expect(projectRequestedRepositories([actual], [], "actual")).toEqual([]);
});
