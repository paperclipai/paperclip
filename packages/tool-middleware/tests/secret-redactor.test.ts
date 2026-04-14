import { describe, it, expect } from "vitest";
import { redactSecrets, redactSecretsInValue } from "../src/secret-redactor.js";

describe("redactSecrets", () => {
  it("redacts AWS access key IDs", () => {
    const input = "Key: AKIAIOSFODNN7EXAMPLE and other data";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:aws_key_id]");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts AWS secret access key assignments", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:aws_secret]");
    expect(output).not.toContain("wJalrXUtnFEMI");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts API key assignments", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:secret]");
    expect(output).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts password assignments", () => {
    const input = "password=supersecretpassword123";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:password]");
    expect(output).not.toContain("supersecretpassword123");
  });

  it("redacts database connection strings", () => {
    const input = "postgres://admin:mypassword@db.example.com:5432/mydb";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:credentials]");
    expect(output).not.toContain("mypassword");
    expect(output).toContain("db.example.com:5432/mydb");
  });

  it("redacts GitHub tokens", () => {
    // ghp_ followed by exactly 36 alphanumeric chars (minimum for pattern)
    const input = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:github_token]");
  });

  it("redacts PEM private keys", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4YMI6EzKCjV9kFNjRJfKFDjVmBf",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED:private_key]");
    expect(output).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("does not redact non-secret content", () => {
    const input = "Hello world, this is a normal log message with no secrets.";
    const output = redactSecrets(input);
    expect(output).toBe(input);
  });

  it("does not expose secrets on re-redaction of already-redacted content", () => {
    // After redaction, the output should not contain any real secret
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
    const once = redactSecrets(input);
    const twice = redactSecrets(once);
    // Both passes should have removed the secret
    expect(once).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(twice).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });
});

describe("redactSecretsInValue", () => {
  it("redacts strings nested in objects", () => {
    const input = {
      token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
      nested: { password: "password=mypassword" },
    };
    const output = redactSecretsInValue(input) as typeof input;
    expect(output.token).toContain("[REDACTED:token]");
    expect(output.nested.password).toContain("[REDACTED:password]");
  });

  it("redacts strings in arrays", () => {
    const input = ["Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"];
    const output = redactSecretsInValue(input) as string[];
    expect(output[0]).toContain("[REDACTED:token]");
  });

  it("leaves non-string values untouched", () => {
    const input = { count: 42, flag: true, nothing: null };
    const output = redactSecretsInValue(input);
    expect(output).toEqual(input);
  });
});
