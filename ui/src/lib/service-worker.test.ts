import { describe, expect, it } from "vitest";
import { shouldRegisterServiceWorker } from "./service-worker";

describe("shouldRegisterServiceWorker", () => {
  it("does not register the service worker in development", () => {
    expect(shouldRegisterServiceWorker({ isProduction: false, hasServiceWorkerApi: true })).toBe(false);
  });

  it("registers the service worker in production when the browser supports it", () => {
    expect(shouldRegisterServiceWorker({ isProduction: true, hasServiceWorkerApi: true })).toBe(true);
  });
});
