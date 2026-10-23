import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runVallelyLeadFormPayloadProbe } from "./vallely-lead-form-payload-probe.mjs";

async function tmpFile(name = "artifact.json") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vallely-lead-form-payload-probe-"));
  return path.join(dir, name);
}

async function writeLeads(payload) {
  const file = await tmpFile("leads.json");
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

describe("runVallelyLeadFormPayloadProbe", () => {
  it("records a full pass when the synthetic lead arrives in DP360 with the required payload", async () => {
    const artifactFile = await tmpFile();
    const leadsFile = await writeLeads({
      leads: [
        {
          lead_id: "dp360-1",
          run_id: "probe-pass",
          customer_name: "Synthetic Payload obe-pass",
          email: "synthetic+probe-pass@example.invalid",
          phone: "+1 (555) 010-1010",
          leadSource: "paperclip_vallely_lead_form_payload_probe",
          listingId: "XA11882",
          comments: "Synthetic Vallely lead-form payload probe; run_id=probe-pass; synthetic=true; delete_after=true",
          createdAt: "2026-05-13T12:00:30.000Z",
        },
      ],
    });

    const { artifact } = await runVallelyLeadFormPayloadProbe({
      now: new Date("2026-05-13T12:00:00.000Z"),
      env: {
        VALLELY_LEAD_FORM_PROBE_RUN_ID: "probe-pass",
        VALLELY_LEAD_FORM_PROBE_LISTING_ID: "XA11882",
        VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE: artifactFile,
        DP360_LEADS_INPUT_FILE: leadsFile,
      },
    });

    assert.equal(artifact.status, "ok");
    assert.equal(artifact.crm_lookup.found, true);
    assert.deepEqual(artifact.crm_validation.missing, []);
    assert.deepEqual(artifact.crm_validation.mismatched, []);
    assert.equal(artifact.crm_validation.arrival_lag_seconds, 30);

    const persisted = JSON.parse(await readFile(artifactFile, "utf8"));
    assert.equal(persisted.expected_fields.includes("listing_id"), true);
  });

  it("fails when DP360 omits required lead-form fields", async () => {
    const artifactFile = await tmpFile();
    const leadsFile = await writeLeads({
      leads: [
        {
          run_id: "probe-missing",
          email: "synthetic+probe-missing@example.invalid",
          phone: "+15550101010",
          leadSource: "paperclip_vallely_lead_form_payload_probe",
          comments: "run_id=probe-missing",
        },
      ],
    });

    const { artifact } = await runVallelyLeadFormPayloadProbe({
      now: new Date("2026-05-13T12:00:00.000Z"),
      env: {
        VALLELY_LEAD_FORM_PROBE_RUN_ID: "probe-missing",
        VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE: artifactFile,
        DP360_LEADS_INPUT_FILE: leadsFile,
      },
    });

    assert.equal(artifact.status, "failed");
    assert.deepEqual(artifact.crm_validation.missing.sort(), ["listing_id", "name"].sort());
  });

  it("posts the canonical lead form before polling CRM in production mode", async () => {
    const artifactFile = await tmpFile();
    const calls = [];
    const fetcher = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET", body: options.body });
      if (options.method === "POST") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: "form-submission-1" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            leads: [
              {
                runId: "probe-production",
                fullName: "Synthetic Payload duction",
                emailAddress: "synthetic+probe-production@example.invalid",
                phoneNumber: "15550101010",
                source: "paperclip_vallely_lead_form_payload_probe",
                stockNumber: "B8415",
                note: "Synthetic Vallely lead-form payload probe; run_id=probe-production",
                created_at: "2026-05-13T12:00:10.000Z",
              },
            ],
          };
        },
      };
    };

    const { artifact } = await runVallelyLeadFormPayloadProbe({
      now: new Date("2026-05-13T12:00:00.000Z"),
      fetcher,
      sleep: async () => {},
      env: {
        VALLELY_LEAD_FORM_PROBE_MODE: "production",
        ALLOW_PRODUCTION_SYNTHETIC_LEADS: "true",
        VALLELY_LEAD_FORM_PROBE_RUN_ID: "probe-production",
        VALLELY_LEAD_FORM_PROBE_LISTING_ID: "B8415",
        VALLELY_LEAD_FORM_ENDPOINT_URL: "https://vallely.example.test/api/lead-form",
        VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE: artifactFile,
        DP360_DEALER_ID: "dealer-1",
        DP360_API_TOKEN: "token-1",
      },
    });

    assert.equal(artifact.status, "ok");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://vallely.example.test/api/lead-form");
    const submitted = new URLSearchParams(calls[0].body);
    assert.equal(submitted.get("fname"), "Synthetic");
    assert.equal(submitted.get("lname"), "Payload oduction");
    assert.equal(submitted.get("email"), "synthetic+probe-production@example.invalid");
    assert.equal(submitted.get("telephone"), "+15550101010");
    assert.equal(submitted.get("comments")?.includes("run_id=probe-production"), true);
    assert.equal(submitted.get("location"), "Bismarck ND");
    assert.equal(submitted.get("formpage"), "xinquiry");
    assert.equal(submitted.get("SourcePage"), "xinquiry");
    assert.equal(submitted.get("oid"), "B8415");
    assert.equal(submitted.get("source"), "paperclip_vallely_lead_form_payload_probe");
    assert.equal(artifact.submission.payload_format, "dealerspike-form");
    assert.equal(artifact.submission.submitted_payload.oid, "B8415");
    assert.match(calls[1].url, /\/leads\/dealer-1\.json$/);
  });

  it("allows explicit JSON lead-form submissions for non-DealerSpike endpoints", async () => {
    const artifactFile = await tmpFile();
    const calls = [];
    const fetcher = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET", headers: options.headers, body: options.body });
      return {
        ok: true,
        status: 200,
        async json() {
          return options.method === "POST"
            ? { id: "json-form-submission" }
            : {
                leads: [
                  {
                    runId: "probe-json",
                    fullName: "Synthetic Payload obe-json",
                    emailAddress: "synthetic+probe-json@example.invalid",
                    phoneNumber: "15550101010",
                    source: "paperclip_vallely_lead_form_payload_probe",
                    stockNumber: "15329398",
                    note: "Synthetic Vallely lead-form payload probe; run_id=probe-json",
                    created_at: "2026-05-13T12:00:10.000Z",
                  },
                ],
              };
        },
      };
    };

    const { artifact } = await runVallelyLeadFormPayloadProbe({
      now: new Date("2026-05-13T12:00:00.000Z"),
      fetcher,
      env: {
        VALLELY_LEAD_FORM_PROBE_MODE: "production",
        ALLOW_PRODUCTION_SYNTHETIC_LEADS: "true",
        VALLELY_LEAD_FORM_PAYLOAD_FORMAT: "json",
        VALLELY_LEAD_FORM_PROBE_RUN_ID: "probe-json",
        VALLELY_LEAD_FORM_ENDPOINT_URL: "https://vallely.example.test/api/json-lead-form",
        VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE: artifactFile,
        DP360_DEALER_ID: "dealer-1",
        DP360_API_TOKEN: "token-1",
      },
    });

    assert.equal(artifact.status, "ok");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.equal(JSON.parse(calls[0].body).listing_id, "15329398");
    assert.equal(artifact.submission.payload_format, "json");
  });

  it("sends an alert when CRM arrival times out", async () => {
    const artifactFile = await tmpFile();
    const calls = [];
    const fetcher = async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        async json() {
          return url.includes("alert") ? { ok: true } : { leads: [] };
        },
      };
    };

    const { artifact } = await runVallelyLeadFormPayloadProbe({
      now: new Date("2026-05-13T12:00:00.000Z"),
      fetcher,
      sleep: async () => {},
      env: {
        VALLELY_LEAD_FORM_PROBE_RUN_ID: "probe-timeout",
        VALLELY_LEAD_FORM_PROBE_TIMEOUT_SECONDS: "0",
        VALLELY_LEAD_FORM_PROBE_ALERT_URL: "https://hooks.example.test/alert",
        VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE: artifactFile,
        DP360_DEALER_ID: "dealer-1",
        DP360_API_TOKEN: "token-1",
      },
    });

    assert.equal(artifact.status, "failed");
    assert.equal(artifact.error.code, "crm_arrival_timeout");
    assert.equal(artifact.alert.status, "sent");
    assert.equal(calls.some((call) => call.url === "https://hooks.example.test/alert" && call.method === "POST"), true);
  });
});
