import { describe, expect, it } from "vitest";
import { webhookUrlWarningReason } from "./webhook-url-warning";

describe("webhookUrlWarningReason", () => {
  it.each([
    ["http://localhost:3100/fire", "loopback"],
    ["https://app.localhost./fire", "loopback"],
    ["http://127.1/fire", "loopback"],
    ["http://0x7f000001/fire", "loopback"],
    ["https://[::1]/fire", "loopback"],
    ["https://[::ffff:127.0.0.1]/fire", "loopback"],
    ["http://0.0.0.0/fire", "loopback"],
    ["https://10.1.2.3/fire", "private"],
    ["https://172.16.0.1/fire", "private"],
    ["https://172.31.255.255/fire", "private"],
    ["https://192.168.1.2/fire", "private"],
    ["https://169.254.1.2/fire", "private"],
    ["https://100.64.0.1/fire", "private"],
    ["https://100.127.255.255/fire", "private"],
    ["https://[fd00::1]/fire", "private"],
    ["https://[fc00::1]/fire", "private"],
    ["https://[fe80::1]/fire", "private"],
    ["https://[::ffff:192.168.1.2]/fire", "private"],
    ["https://paperclip/fire", "private"],
    ["https://paperclip.internal/fire", "private"],
    ["https://paperclip.local/fire", "private"],
    ["https://paperclip.home.arpa/fire", "private"],
    ["https://paperclip.example-tailnet.ts.net/fire", "tailscale"],
    ["http://PAPERCLIP.EXAMPLE-TAILNET.TS.NET./fire", "tailscale"],
    ["http://paperclip.example.com/fire", "https"],
    ["https://paperclip.example.com/fire", null],
    ["https://172.32.0.1/fire", null],
    ["https://100.128.0.1/fire", null],
    ["https://[2606:4700::1111]/fire", null],
    ["https://[::ffff:8.8.8.8]/fire", null],
    ["https://ts.net.example.com/fire", null],
    ["ftp://paperclip.example.com/fire", "invalid"],
    ["not a URL", "invalid"],
    ["", null],
  ])("classifies %s as %s", (url, expected) => {
    expect(webhookUrlWarningReason(url)).toBe(expected);
  });
});
