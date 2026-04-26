import { describe, expect, it } from "vitest";
import { redactForIndex } from "../routes/embed.js";

describe("redactForIndex", () => {
  it("returns empty string as-is", () => {
    expect(redactForIndex("")).toBe("");
  });

  it("returns plain text as-is", () => {
    expect(redactForIndex("This is plain text without any secrets.")).toBe(
      "This is plain text without any secrets."
    );
  });

  describe("JWTs", () => {
    it("redacts JWT tokens", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(redactForIndex(`Bearer ${jwt}`)).toBe("Bearer [REDACTED]");
    });

    it("redacts multiple JWTs in same text", () => {
      expect(redactForIndex("Token1: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.abc Token2: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoyfQ.def")).toBe(
        "Token1: [REDACTED] Token2: [REDACTED]"
      );
    });

    it("redacts minimal JWT patterns", () => {
      expect(redactForIndex("eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.abc")).toBe("[REDACTED]");
    });
  });

  describe("emails", () => {
    it("redacts email addresses", () => {
      expect(redactForIndex("Contact user@example.com for details")).toBe(
        "Contact [REDACTED] for details"
      );
    });

    it("redacts multiple emails", () => {
      expect(redactForIndex("Email alice@test.co.uk and bob@company.com")).toBe(
        "Email [REDACTED] and [REDACTED]"
      );
    });

    it("redacts emails with uncommon TLDs", () => {
      expect(redactForIndex("Send to admin@domain.xyz")).toBe("Send to [REDACTED]");
    });

    it("redacts emails with dots in local part", () => {
      expect(redactForIndex("Contact john.doe@company.co.uk")).toBe("Contact [REDACTED]");
    });
  });

  describe("AWS ARNs", () => {
    it("redacts AWS ARNs", () => {
      expect(redactForIndex("arn:aws:iam::123456789012:role/MyRole")).toBe(
        "[REDACTED]"
      );
    });

    it("redacts ARNs with colons in resource", () => {
      expect(redactForIndex("arn:aws:s3:::my-bucket/path/to/object")).toBe(
        "[REDACTED]"
      );
    });

    it("redacts various AWS service ARNs", () => {
      expect(redactForIndex("arn:aws:lambda:us-east-1:123456789012:function:MyFunc")).toBe("[REDACTED]");
      expect(redactForIndex("arn:aws:sns:us-west-2:123456789012:topic:MyTopic")).toBe("[REDACTED]");
    });
  });

  describe("IP addresses", () => {
    it("redacts IPv4 addresses", () => {
      expect(redactForIndex("Server at 192.168.1.1 and 10.0.0.255")).toBe(
        "Server at [REDACTED] and [REDACTED]"
      );
    });

    it("redacts full IPv6 addresses", () => {
      expect(redactForIndex("Connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(
        "Connect to [REDACTED]"
      );
    });

    it("redacts compressed IPv6 addresses", () => {
      expect(redactForIndex("IPv6: fe80::1")).toBe("IPv6: [REDACTED]");
    });

    it("redacts IPv4 in different contexts", () => {
      const input = "ldap://192.168.1.1:389 or https://10.0.0.1:8080";
      expect(redactForIndex(input)).toBe("ldap://[REDACTED]:389 or https://[REDACTED]:8080");
    });
  });

  describe("combined redaction", () => {
    it("redacts multiple secret types in same text", () => {
      const input = `User testuser@example.com accessed bucket arn:aws:s3:::data-lake. From IP 10.0.0.1 with JWT eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.abc`;
      const result = redactForIndex(input);
      expect(result).toBe("User [REDACTED] accessed bucket [REDACTED]. From IP [REDACTED] with JWT [REDACTED]");
      expect(result).not.toContain("testuser@example.com");
      expect(result).not.toContain("10.0.0.1");
      expect(result).not.toContain("eyJ");
    });

    it("handles text with no secrets", () => {
      const plainText = "The quick brown fox jumps over the lazy dog. 12345";
      expect(redactForIndex(plainText)).toBe(plainText);
    });
  });

  describe("API key patterns", () => {
    it("redacts sk_live_ patterns with 20+ char suffix", () => {
      expect(redactForIndex("sk_live_REDACTED000000000000")).toBe("[REDACTED]");
    });

    it("redacts sk_test_ patterns with 20+ char suffix", () => {
      expect(redactForIndex("sk_test_REDACTED0000000000000")).toBe("[REDACTED]");
    });

    it("redacts pk_live_ patterns with 20+ char suffix", () => {
      expect(redactForIndex("pk_live_REDACTED00000000000000")).toBe("[REDACTED]");
    });

    it("redacts whsec_ patterns with 20+ char suffix", () => {
      expect(redactForIndex("whsec_REDACTED000000000000000")).toBe("[REDACTED]");
    });

    it("redacts gho_ patterns with 20+ char suffix", () => {
      expect(redactForIndex("gho_REDACTED00000000000000000")).toBe("[REDACTED]");
    });

    it("does not redact sk_live_ with short suffix", () => {
      expect(redactForIndex("sk_live_short")).toBe("sk_live_short");
    });

    it("redacts multiple API key types in combined text", () => {
      const input = "Key1: sk_live_REDACTED000000000000, Key2: whsec_REDACTED000000000000000";
      const result = redactForIndex(input);
      expect(result).toBe("Key1: [REDACTED], Key2: [REDACTED]");
      expect(result).not.toContain("sk_live");
      expect(result).not.toContain("whsec_");
    });
  });
});
