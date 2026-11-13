import { expect, it } from "vitest";
import { paperclipCloudEnrollmentPrincipal } from "./paperclip-cloud-connector-principal.js";

it("uses the same enrollment principal namespace for users and local board actors", () => {
  expect(paperclipCloudEnrollmentPrincipal({ userId: "fixture-user", source: "session" })).toBe("user:fixture-user");
  expect(paperclipCloudEnrollmentPrincipal({ source: "local_implicit" })).toBe("source:local_implicit");
  expect(paperclipCloudEnrollmentPrincipal({ userId: "source:local_implicit" })).toBe("user:source:local_implicit");
  expect(paperclipCloudEnrollmentPrincipal({})).toBe("source:board");
});
