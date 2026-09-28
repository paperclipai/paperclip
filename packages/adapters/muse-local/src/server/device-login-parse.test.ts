import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUSE_DEVICE_LOGIN_COMMAND, parseMuseDeviceLoginPrompt } from "./device-login-parse.js";

const pty = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "device-login-prompt-pty.txt"), "utf8");
const prompt = (url: string, code = "QWMM-NVMF") =>
  `Open this page to sign in:\n  ${url}\nconfirm this code matches:\n  ${code}\n\nWaiting for approval…\n`;
const GOOD = "https://auth.meta.com/oauth/device/?code=QWMM-NVMF";

describe("parseMuseDeviceLoginPrompt", () => {
  it("names the login command", () => expect(MUSE_DEVICE_LOGIN_COMMAND).toBe("muse login"));

  it("parses the captured pseudo-terminal prompt (CRLF)", () => {
    expect(parseMuseDeviceLoginPrompt(pty)).toEqual({ url: GOOD, code: "QWMM-NVMF" });
  });

  it("parses the headless prompt", () => {
    expect(parseMuseDeviceLoginPrompt(prompt(GOOD))).toEqual({ url: GOOD, code: "QWMM-NVMF" });
  });

  it("parses an ANSI-coloured code", () => {
    expect(parseMuseDeviceLoginPrompt(prompt(GOOD, "\x1b[1mQWMM-NVMF\x1b[0m"))).toEqual({ url: GOOD, code: "QWMM-NVMF" });
  });

  it("waits for the code line", () => {
    expect(parseMuseDeviceLoginPrompt(`Open this page to sign in:\n  ${GOOD}\n`)).toBeNull();
  });

  it.each([
    ["http scheme", "http://auth.meta.com/oauth/device/?code=QWMM-NVMF"],
    ["lookalike host", "https://auth.meta.com.evil.io/oauth/device/?code=QWMM-NVMF"],
    ["missing trailing slash", "https://auth.meta.com/oauth/device?code=QWMM-NVMF"],
    ["other path", "https://auth.meta.com/oauth/devicex/?code=QWMM-NVMF"],
    ["extra query key", "https://auth.meta.com/oauth/device/?code=QWMM-NVMF&next=x"],
    ["repeated code", "https://auth.meta.com/oauth/device/?code=QWMM-NVMF&code=QWMM-NVMF"],
    ["fragment", "https://auth.meta.com/oauth/device/?code=QWMM-NVMF#x"],
    ["credentials", "https://user:pass@auth.meta.com/oauth/device/?code=QWMM-NVMF"],
  ])("rejects %s", (_name, url) => {
    expect(parseMuseDeviceLoginPrompt(prompt(url))).toBeNull();
  });

  it.each([["lowercase", "qwmm-nvmf"], ["short", "QWMM-NVM"]])("rejects a %s code", (_name, code) => {
    expect(parseMuseDeviceLoginPrompt(prompt(`https://auth.meta.com/oauth/device/?code=${code}`, code))).toBeNull();
  });

  it("rejects a line code that differs from the URL code", () => {
    expect(parseMuseDeviceLoginPrompt(prompt(GOOD, "ABCD-EFGH"))).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseMuseDeviceLoginPrompt(undefined as unknown as string)).toBeNull();
  });
});
