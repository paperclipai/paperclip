// Gate logic AC verification — exercises evaluateApprovalGate.
import { evaluateApprovalGate, parseProvenance } from "../lib/asset-type";

const cases = [
  {
    name: "AC1 missing provenance",
    doc: { body: "# Just a brief\n\nno frontmatter here", metadata: undefined },
    docKey: "post-body.md",
    exception: null,
    expect: { allowed: false, status: "missing" },
  },
  {
    name: "AC2 cloud tool no waiver",
    doc: {
      body: "---\nprovenance_kind: cloud-ai-exception\ntool: Runway Gen-3\nmodel: gen3-alpha\n---\n",
      metadata: undefined,
    },
    docKey: "video.mp4",
    exception: null,
    expect: { allowed: false, status: "cloud" },
  },
  {
    name: "AC2b cloud tool with valid waiver",
    doc: {
      body:
        "---\nprovenance_kind: cloud-ai-exception\ntool: Runway Gen-3\nmodel: gen3-alpha\nexception_issue_id: GLA-9999\n---\n",
      metadata: undefined,
    },
    docKey: "video.mp4",
    exception: { identifier: "GLA-9999", status: "done", title: "[tool-exception] runway demo", valid: true },
    expect: { allowed: true, status: "cloud-with-exception" },
  },
  {
    name: "AC2c cloud tool with invalid waiver",
    doc: {
      body:
        "---\nprovenance_kind: cloud-ai-exception\ntool: Heygen avatar\nexception_issue_id: GLA-9998\n---\n",
      metadata: undefined,
    },
    docKey: "video.mp4",
    exception: { identifier: "GLA-9998", status: "todo", title: "[tool-exception] heygen demo", valid: false },
    expect: { allowed: false, status: "exception-invalid" },
  },
  {
    name: "AC3 local-ai allowed",
    doc: {
      body:
        "---\nprovenance_kind: local-ai\ntool: ComfyUI\nmodel: Flux/SDXL\nworkflow_ref: workflows/foo.json\nseed: 42\n---\nbody\n",
      metadata: undefined,
    },
    docKey: "image.png",
    exception: null,
    expect: { allowed: true, status: "ok" },
  },
  {
    name: "AC1+stock filename pattern",
    doc: {
      body:
        "---\nprovenance_kind: local-ai\ntool: ComfyUI\nmodel: Flux\n---\n",
      metadata: undefined,
    },
    docKey: "shutterstock_12345678.jpg",
    exception: null,
    expect: { allowed: false, status: "stock" },
  },
  {
    name: "founder-original allowed",
    doc: {
      body:
        "---\nprovenance_kind: founder-original\ntool: iPhone 15\n---\n",
      metadata: undefined,
    },
    docKey: "voice-clip.mp4",
    exception: null,
    expect: { allowed: true, status: "ok" },
  },
];

let fail = 0;
for (const c of cases) {
  const prov = parseProvenance(c.doc);
  const gate = evaluateApprovalGate(prov, c.docKey, c.exception);
  const ok = gate.allowed === c.expect.allowed && gate.status === c.expect.status;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.name}: allowed=${gate.allowed} status=${gate.status} banner="${gate.banner ?? ""}"`,
  );
  if (!ok) {
    console.log("  prov:", prov);
    console.log("  expected:", c.expect);
    fail++;
  }
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
