import { describe, expect, it } from "vitest";

import {
  ALERT_TEMPLATE_PII_CONTROL_VERSION,
  ENFORCED_LAYER,
  PiiTemplateError,
  assertAlertTemplateRegistration,
  enforcedPatternIds,
  getEnforcedPatterns,
  loadRegistrationRecord,
  validateRegistrationTemplates,
} from "../services/alert-template-registration.ts";

const EXPECTED_PATTERNS = ["ssn", "email", "credit_card", "freeform_string_unbound"];

describe("alert-template registration binding", () => {
  it("declares the alert-template-engine enforcement layer", () => {
    expect(ENFORCED_LAYER).toBe("alert_template_engine");
    expect(ALERT_TEMPLATE_PII_CONTROL_VERSION).toBe(1);
  });

  it("sources the enforced pattern ids from the canonical module", () => {
    expect(enforcedPatternIds().sort()).toEqual([...EXPECTED_PATTERNS].sort());
  });

  it("loads the committed registration record and binds its pattern list", () => {
    const record = loadRegistrationRecord();
    expect(getEnforcedPatterns(record).sort()).toEqual([...EXPECTED_PATTERNS].sort());
  });

  it("fails-closed when the record does not opt into allowlist-only mode", () => {
    const record = structuredClone(loadRegistrationRecord());
    record.pii_allowlist_only = false;
    expect(() => getEnforcedPatterns(record)).toThrow(/pii_allowlist_only/);
  });

  it("fails-closed when the record declares no pattern list", () => {
    const missing = structuredClone(loadRegistrationRecord());
    delete missing.pii_rejection_patterns;
    expect(() => getEnforcedPatterns(missing)).toThrow(/fail-closed/);

    const empty = structuredClone(loadRegistrationRecord());
    empty.pii_rejection_patterns = [];
    expect(() => getEnforcedPatterns(empty)).toThrow(/fail-closed/);
  });

  it("fails-closed when the record expects a pattern the engine does not enforce", () => {
    const record = structuredClone(loadRegistrationRecord());
    record.pii_rejection_patterns = [...EXPECTED_PATTERNS, "biometric_template"];
    expect(() => getEnforcedPatterns(record)).toThrow(/under-enforce/);
  });

  it("fails-closed when the declared list drifts below what the engine enforces", () => {
    const record = structuredClone(loadRegistrationRecord());
    record.pii_rejection_patterns = ["ssn", "email"];
    expect(() => getEnforcedPatterns(record)).toThrow(/drifted/);
  });
});

describe("alert-template registration enforcement", () => {
  it("rejects a PII-leaking template at registration with the named pattern", () => {
    let thrown: unknown;
    try {
      assertAlertTemplateRegistration({
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

  it("rejects a bare numeric PII body against the committed record", () => {
    let ssnThrown: unknown;
    try {
      assertAlertTemplateRegistration({
        id: "kill-plane-bare-ssn-alert",
        subject: "Operator identity",
        body: "078051120",
        labels: {},
        fields: {},
      });
    } catch (error) {
      ssnThrown = error;
    }
    expect(ssnThrown).toBeInstanceOf(PiiTemplateError);
    if (ssnThrown instanceof PiiTemplateError) {
      expect(ssnThrown.violations[0].pattern).toBe("ssn");
    }

    let panThrown: unknown;
    try {
      assertAlertTemplateRegistration({
        id: "kill-plane-bare-pan-alert",
        subject: "Gateway charge",
        body: "4111111111111111",
        labels: {},
        fields: {},
      });
    } catch (error) {
      panThrown = error;
    }
    expect(panThrown).toBeInstanceOf(PiiTemplateError);
    if (panThrown instanceof PiiTemplateError) {
      expect(panThrown.violations[0].pattern).toBe("credit_card");
    }
  });

  it("accepts a fully PII-safe kill-plane template", () => {
    expect(() =>
      assertAlertTemplateRegistration({
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
      }),
    ).not.toThrow();
  });

  it("refuses to register against a tampered (fail-closed) record", () => {
    const record = structuredClone(loadRegistrationRecord());
    record.pii_allowlist_only = false;
    expect(() =>
      assertAlertTemplateRegistration({ id: "safe", subject: "ok", fields: {} }, record),
    ).toThrow(/pii_allowlist_only/);
  });

  it("revalidates a template corpus and reports only failing templates", () => {
    const corpus = [
      { id: "good", subject: "{{ severity }} breach", fields: { severity: { enum: ["Sev1"] } } },
      { id: "leaky-ssn", body: "ref 123-45-6789", fields: {} },
      { id: "leaky-unbound", body: "{{ raw.notes }}", fields: { "raw.notes": { type: "string" } } },
    ];
    const { ok, failures, enforcedPatterns } = validateRegistrationTemplates(corpus);
    expect(ok).toBe(false);
    expect(enforcedPatterns.sort()).toEqual([...EXPECTED_PATTERNS].sort());
    expect(failures.map((failure) => failure.id).sort()).toEqual(["leaky-ssn", "leaky-unbound"]);
  });

  it("passes a clean corpus and surfaces the record-bound pattern list", () => {
    const corpus = [
      { id: "ok-metric", subject: "{{ metric.name }}", fields: { "metric.name": { piiSafeKind: "metric_ref" } } },
    ];
    const { ok, failures } = validateRegistrationTemplates(corpus);
    expect(ok).toBe(true);
    expect(failures).toEqual([]);
  });
});
