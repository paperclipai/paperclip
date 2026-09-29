import { expect, it } from "vitest";
import { classifyNativeAuthorityStorageError } from "./native-authority-storage-error.js";

it("classifies bounded structured database/filesystem causes without parsing messages", () => {
  for (const code of ["53100", "53200", "53300", "ENOSPC", "EDQUOT"]) {
    expect(classifyNativeAuthorityStorageError(new Error("query failed", { cause: Object.assign(new Error("private backend details"), { code }) })))
      .toMatchObject({ code: "storage_pressure", message: "storage_pressure: authority storage capacity is temporarily unavailable" });
  }
  for (const code of ["08006", "57P01", "25006", "EROFS", "ECONNRESET"]) {
    expect(classifyNativeAuthorityStorageError({ code })).toMatchObject({ code: "storage_unavailable" });
  }
  for (const error of [new Error("53100: disk full"), { code: "23505" }, { code: "42501" }, { cause: null }]) {
    expect(classifyNativeAuthorityStorageError(error)).toBe(error);
  }
  const cycle = { cause: null as unknown }; cycle.cause = cycle;
  expect(classifyNativeAuthorityStorageError(cycle)).toBe(cycle);
});
