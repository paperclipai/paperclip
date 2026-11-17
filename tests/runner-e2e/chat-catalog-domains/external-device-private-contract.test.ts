import { expect, it } from "vitest";
import { matchesDevicePrivateReceipt, validDevicePrivateInput } from "./external-device-private-contract.js";

const base = "http://127.0.0.1:3100";
const code = "ABCD-EFGH"; // Synthetic calibration only, never a provider-issued code.
const url = `${base}/mcp-device?user_code=${code}`;
const company = "11111111-1111-4111-8111-111111111111";
const device = { userId: "fixture-person", companyName: "Owned company" };

it("allows only the exact owned device page and current code for two finite phases", () => {
  for (const mode of ["device-approve", "device-expired"]) {
    expect(validDevicePrivateInput(mode, base, url, company, device, code)).toBe(true);
    for (const target of [
      url.replace("127.0.0.1", "example.test"), url.replace("http:", "https:"),
      url.replace("/mcp-device", "/mcp-connect"), url + "&next=/other", url + "#secret",
      url.replace(code, "WXYZ-1234"), url + `&user_code=${code}`,
      url.replace("http://", "http://user:password@"),
    ]) expect(validDevicePrivateInput(mode, base, target, company, device, code)).toBe(false);
  }
  expect(validDevicePrivateInput("arbitrary", base, url, company, device, code)).toBe(false);
  expect(validDevicePrivateInput("device-approve", base, url, company, undefined, code)).toBe(false);
  expect(validDevicePrivateInput("device-approve", base, url, "wrong", device, code)).toBe(false);
  expect(validDevicePrivateInput("device-approve", base, url, company, { ...device, userId: "" }, code)).toBe(false);
  expect(validDevicePrivateInput("device-approve", base, url, company, device, "bad\r\ncode")).toBe(false);
});

it("accepts only complete boolean-only private receipts, never codes, URLs or forged capture claims", () => {
  const boundary = { processIsolation: true, testRunnerAttached: false, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false, deviceSessionVerified: true };
  const approval = { ...boundary, currentCodeVisible: true, companyConsentVisible: true, readScopeVisible: true, humanApproved: true };
  const expired = { ...boundary, expiredPageVisible: true };
  expect(matchesDevicePrivateReceipt("device-approve", approval)).toBe(true);
  expect(matchesDevicePrivateReceipt("device-expired", expired)).toBe(true);
  for (const wrong of [undefined, {}, expired, { ...approval, tracingEnabled: true }, { ...approval, deviceSessionVerified: false }, { ...approval, currentCodeVisible: false }, { ...approval, userCode: code }, { ...approval, verificationUri: url }, { ...approval, humanApproved: "true" }])
    expect(matchesDevicePrivateReceipt("device-approve", wrong)).toBe(false);
  expect(matchesDevicePrivateReceipt("device-expired", { ...expired, expiredPageVisible: false })).toBe(false);
});
