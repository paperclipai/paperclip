import assert from "node:assert/strict";
import test from "node:test";
import {
  isForceForeground,
  isNoServiceRequested,
  isProtectedCheckoutPath,
  isServiceActiveStatus,
  resolveDelegateShimPath,
  shouldStartTempServer,
  shouldWaitOnTempServer,
} from "./delegate-service.mjs";

test("resolveDelegateShimPath points at the executable shim", () => {
  assert.match(resolveDelegateShimPath("/repo"), /\/repo\/scripts\/delegate-service-shim\.sh$/);
});

test("isServiceActiveStatus requires installed and active", () => {
  assert.equal(isServiceActiveStatus({ installed: true, active: true }), true);
  assert.equal(isServiceActiveStatus({ installed: true, active: false }), false);
  assert.equal(isServiceActiveStatus({ installed: false, active: false }), false);
  assert.equal(isServiceActiveStatus(null), false);
});

test("temp server starts only when nothing serves", () => {
  assert.equal(shouldStartTempServer({ healthOk: false, serviceActive: false }), true);
  assert.equal(shouldStartTempServer({ healthOk: true, serviceActive: false }), false);
  assert.equal(shouldStartTempServer({ healthOk: false, serviceActive: true }), false);
  assert.equal(shouldStartTempServer({ healthOk: true, serviceActive: true }), false);
});

test("installed-but-unhealthy service never gains a second server", () => {
  assert.equal(
    shouldStartTempServer({ healthOk: false, serviceActive: false, serviceInstalledUnhealthy: true }),
    false,
  );
});

test("foreground wait is skipped when the service owns the process", () => {
  assert.equal(
    shouldWaitOnTempServer({ serviceActive: true, tempServerStarted: true, exitAfterSetup: false }),
    false,
  );
  assert.equal(
    shouldWaitOnTempServer({ serviceActive: false, tempServerStarted: true, exitAfterSetup: false }),
    true,
  );
  assert.equal(
    shouldWaitOnTempServer({ serviceActive: false, tempServerStarted: false, exitAfterSetup: false }),
    false,
  );
  assert.equal(
    shouldWaitOnTempServer({ serviceActive: false, tempServerStarted: true, exitAfterSetup: true }),
    false,
  );
});

test("protected checkout detection covers macOS privacy folders", () => {
  const home = "/Users/alice";
  assert.equal(isProtectedCheckoutPath("/Users/alice/Desktop/paperclip", home, "darwin"), true);
  assert.equal(isProtectedCheckoutPath("/Users/alice/Desktop", home, "darwin"), true);
  assert.equal(isProtectedCheckoutPath("/Users/alice/Documents/work", home, "darwin"), true);
  assert.equal(isProtectedCheckoutPath("/Users/alice/Downloads/repo", home, "darwin"), true);
  assert.equal(isProtectedCheckoutPath("/Users/alice/code/paperclip", home, "darwin"), false);
  assert.equal(isProtectedCheckoutPath("/Users/alice/DesktopOther/paperclip", home, "darwin"), false);
  assert.equal(isProtectedCheckoutPath("/Users/alice/Desktop/paperclip", home, "linux"), false);
  assert.equal(isProtectedCheckoutPath("", home, "darwin"), false);
});

test("env opt-outs parse truthy values", () => {
  assert.equal(isNoServiceRequested({ PAPERCLIP_DELEGATE_NO_SERVICE: "true" }), true);
  assert.equal(isNoServiceRequested({}), false);
  assert.equal(isForceForeground({ PAPERCLIP_DELEGATE_FORCE_FOREGROUND: "1" }), true);
  assert.equal(isForceForeground({}), false);
});
