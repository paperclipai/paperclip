import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  luhnValid,
  isCreditCard,
  scanLiteral,
  matchSafeShape,
  classifyFieldRef,
  PII_REJECTION_PATTERNS,
} from "../security/alert-template-pii-patterns.js";
import {
  validateAlertTemplate,
  assertAlertTemplate,
  PiiTemplateError,
  revalidateExistingTemplates,
} from "../security/alert-template-pii.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("alert-template PII control", () => {
  test("luhn: validates known-good and rejects bad", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  test("credit_card detector: issuer + length + Luhn", () => {
    expect(isCreditCard("4111 1111 1111 1111")).toBe(true);
    expect(isCreditCard("4111-1111-1111-1111")).toBe(true);
    expect(isCreditCard("378282246310005")).toBe(true);
    expect(isCreditCard("4111111111111112")).toBe(false);
    expect(isCreditCard("1234567890123456")).toBe(false);
  });

  test("safe shapes are recognized", () => {
    expect(matchSafeShape("kill_lease_acquire_latency_seconds")).toBe("metric_ref");
    expect(
      matchSafeShape("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ).toBe("sha256");
    expect(matchSafeShape("550e8400-e29b-41d4-a716-446655440000")).toBe("uuid");
    expect(matchSafeShape("30s")).toBe("duration");
  });

  test("bare numeric strings are not a safe literal shape (no PII bypass)", () => {
    expect(matchSafeShape("42")).toBe(null);
    expect(matchSafeShape("078051120")).toBe(null);
    expect(matchSafeShape("4111111111111111")).toBe(null);
  });

  test("scanLiteral rejects bare numeric PII that previously bypassed via numeric shape", () => {
    expect(scanLiteral("078051120")).toBe("ssn");
    expect(scanLiteral("123456789")).toBe("ssn");
    expect(scanLiteral("4111111111111111")).toBe("credit_card");
    expect(scanLiteral("378282246310005")).toBe("credit_card");
  });

  test("scanLiteral rejects PII with named pattern", () => {
    expect(scanLiteral("contact 123-45-6789 now")).toBe("ssn");
    expect(scanLiteral("compact 123456789 id")).toBe("ssn");
    expect(scanLiteral("email alice@example.com")).toBe("email");
    expect(scanLiteral("card 4111 1111 1111 1111 charged")).toBe("credit_card");
  });

  test("scanLiteral does not false-positive on safe shapes / invalid PII", () => {
    expect(
      scanLiteral("4111111111111111fbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ).toBe(null);
    expect(scanLiteral("550e8400-e29b-41d4-a716-446655440000")).toBe(null);
    expect(scanLiteral("000-12-3456")).toBe(null);
    expect(scanLiteral("666-12-3456")).toBe(null);
    expect(scanLiteral("912-12-3456")).toBe(null);
    expect(scanLiteral("123-00-4567")).toBe(null);
    expect(scanLiteral("123-45-0000")).toBe(null);
    expect(scanLiteral("4111-1111-1111-1112")).toBe(null);
  });

  test("classifyFieldRef defaults to reject unbounded strings", () => {
    expect(classifyFieldRef(undefined).safe).toBe(false);
    expect(classifyFieldRef({ type: "string" }).safe).toBe(false);
    expect(classifyFieldRef({ type: "string", maxLength: 32 }).safe).toBe(false);
    expect(classifyFieldRef({ type: "string", enum: ["a", "b"] }).safe).toBe(true);
    expect(classifyFieldRef({ piiSafeKind: "metric_ref" }).safe).toBe(true);
    expect(classifyFieldRef({ type: "number" }).safe).toBe(true);
  });

  test("canonical regression rejects credit-card-shaped template body", () => {
    let thrown: unknown;
    try {
      assertAlertTemplate({
        id: "kill-plane-payment-alert",
        subject: "Payment processor failure",
        body: "Charge failed for card 4111-1111-1111-1111 on the kill-plane gateway",
        labels: {},
        fields: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PiiTemplateError);
    if (thrown instanceof PiiTemplateError) {
      expect(thrown.violations[0].pattern).toBe("credit_card");
      expect(thrown.message).toMatch(/credit_card/);
    }
  });

  test("rejects SSN, email, unbound fields", () => {
    const ssn = validateAlertTemplate({ id: "t1", subject: "user 078-05-1120", fields: {} });
    expect(ssn.ok).toBe(false);
    expect(ssn.violations[0].pattern).toBe("ssn");

    const email = validateAlertTemplate({
      id: "t2",
      body: "ok",
      labels: { owner: "admin@company.local" },
      fields: {},
    });
    expect(email.ok).toBe(false);
    expect(email.violations[0].pattern).toBe("email");

    const unbound = validateAlertTemplate({
      id: "t3",
      body: "Lease event: {{ event.message }}",
      fields: { "event.message": { type: "string" } },
    });
    expect(unbound.ok).toBe(false);
    expect(unbound.violations[0].pattern).toBe("freeform_string_unbound");
  });

  test("accepts a fully PII-safe kill-plane template", () => {
    const res = validateAlertTemplate({
      id: "kill-lease-latency-alert",
      subject: "Kill-lease SLO breach",
      body:
        "Metric {{ metric.name }} breached tier SLO at {{ event.window }} " +
        "(bundle {{ bundle.hash }}, lease {{ lease.id }})",
      labels: { severity: "{{ severity }}", service: "ram87-p4-kill-plane" },
      fields: {
        "metric.name": { piiSafeKind: "metric_ref" },
        "event.window": { piiSafeKind: "duration" },
        "bundle.hash": { piiSafeKind: "sha256" },
        "lease.id": { piiSafeKind: "uuid" },
        severity: { enum: ["Sev1", "Sev2"] },
      },
    });
    expect(res).toEqual({ ok: true, violations: [] });
  });

  test("revalidateExistingTemplates flags failing corpus", () => {
    const corpus = [
      { id: "good", subject: "{{ severity }} breach", fields: { severity: { enum: ["Sev1"] } } },
      { id: "leaky-ssn", body: "ref 123-45-6789", fields: {} },
      { id: "leaky-unbound", body: "{{ raw.notes }}", fields: { "raw.notes": { type: "string" } } },
    ];
    const failures = revalidateExistingTemplates(corpus);
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.id).sort()).toEqual(["leaky-ssn", "leaky-unbound"]);
  });

  test("YAML control artifact mirrors canonical patterns", () => {
    const yaml = readFileSync(path.join(__dirname, "../security/ram87-p4-alert-template-pii-control.yaml"), "utf8");
    for (const { id, kind } of PII_REJECTION_PATTERNS) {
      expect(yaml).toMatch(new RegExp(`id:\\s*${id}\\b`, "m"));
      expect(yaml).toMatch(new RegExp(`kind:\\s*${kind}\\b`, "m"));
    }
    expect(yaml).toMatch(/source:\s*alert-template-pii-patterns\.ts/);
  });
});
