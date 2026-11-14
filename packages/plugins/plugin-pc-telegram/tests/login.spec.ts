import { describe, expect, it } from "vitest";
import { idleLoginStatus, loginNeedsPassword, reduceLogin } from "../src/login.js";
import { qrImageDataUrl, telegramQrUrl } from "../src/qr.js";

describe("login state machine", () => {
  it("walks QR login through password and connected", () => {
    const loginId = "login-1";
    let status = idleLoginStatus();
    status = reduceLogin(status, { type: "start", loginId });
    expect(status).toMatchObject({ state: "qr_pending", loginId });

    status = reduceLogin(status, {
      type: "qr",
      loginId,
      qr: { imageDataUrl: "data:image/svg+xml;utf8,qr" },
    });
    expect(status.state).toBe("qr_pending");
    if (status.state === "qr_pending") {
      expect(status.qr.imageDataUrl).toContain("data:image/svg+xml");
    }

    status = reduceLogin(status, { type: "password_required", loginId, hint: "Hint" });
    expect(loginNeedsPassword(status)).toBe(true);

    status = reduceLogin(status, {
      type: "connected",
      loginId,
      account: { telegramUserId: "1001", username: "desk", displayName: "Front Desk" },
    });
    expect(status).toMatchObject({
      state: "connected",
      account: { telegramUserId: "1001", username: "desk" },
    });
  });

  it("ignores events for a different login id", () => {
    let status = reduceLogin(idleLoginStatus(), { type: "start", loginId: "a" });
    status = reduceLogin(status, { type: "error", loginId: "b", message: "nope" });
    expect(status.state).toBe("qr_pending");
  });

  it("encodes a Telegram QR without putting the token in SVG text nodes", () => {
    const url = telegramQrUrl(Buffer.from("token-bytes"));
    const qr = qrImageDataUrl(url);
    expect(url.startsWith("tg://login?token=")).toBe(true);
    expect(qr.imageDataUrl.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(qr.imageDataUrl)).not.toContain("tg://login");
  });
});
