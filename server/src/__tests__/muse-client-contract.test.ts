import { execFileSync } from "node:child_process";
import { parsePaperclipQuestionResponse } from "@paperclipai/paperclip-runner";
import { buildMuseSetupInstruction, museReceiverAssets } from "../services/muse-setup.js";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { museTransportRoutes } from "../routes/muse.js";

// Asset routing must not create a credential, touch a DB or start a receiver.
vi.mock("../modules/external-agents/index.js", () => ({ museExternalAgents: () => ({}) }));
vi.mock("../services/muse-identity.js", () => ({ museIdentity: () => ({}) }));
vi.mock("../services/muse-receiver.js", () => ({ museReceiver: () => ({}) }));

/** Execute the shipped Python client, with synthetic transport responses and private temporary state. */
describe("personal Muse client durability", () => {
  it("preserves identities, private credentials, and input receipts across transport failures", () => {
    execFileSync("python3", [
      fileURLToPath(new URL("./fixtures/muse-client-contract.py", import.meta.url)),
      fileURLToPath(new URL("../services/scripts/v9/client.py", import.meta.url)),
    ], { encoding: "utf8", timeout: 30_000 });
  });
});


describe("Muse canonical multi-select compatibility", () => {
  const questionSet = { schema: "paperclip.question_set.v1", questions: [
    { id: "choices", prompt: "Choose supported options", required: true, answerMode: "multi_select",
      options: Array.from({ length: 128 }, (_, index) => ({ id: `choice-${index}`, label: `Choice ${index}` })) },
    { id: "format", prompt: "Choose a format", required: true, answerMode: "text" },
  ] };
  const response = (selectedOptionIds: string[]) => ({ schema: "paperclip.question_response.v1",
    answers: { choices: { selectedOptionIds }, format: { text: "Markdown" } } });
  const clientValid = (value: unknown) => JSON.parse(execFileSync("python3", ["-c",
    "import importlib.util,json,sys; sys.dont_write_bytecode=True; spec=importlib.util.spec_from_file_location('muse_validator',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps(module.input_response_valid(json.load(sys.stdin))))",
    fileURLToPath(new URL("../services/scripts/v9/client.py", import.meta.url)),
  ], { input: JSON.stringify(value), encoding: "utf8", timeout: 5_000 })) as boolean;

  it.each([64, 65, 128])("accepts all %s canonical selections without losing another question", count => {
    const value = response(Array.from({ length: count }, (_, index) => `choice-${index}`));
    expect(parsePaperclipQuestionResponse(questionSet, value)).toEqual(value);
    expect(clientValid(value)).toBe(true);
  });

  it("retains duplicate and overflow rejection and canonical option-membership authority", () => {
    for (const selected of [Array.from({ length: 129 }, (_, index) => `choice-${index}`), ["choice-0", "choice-0"]]) {
      const value = response(selected);
      expect(() => parsePaperclipQuestionResponse(questionSet, value)).toThrow();
      expect(clientValid(value)).toBe(false);
    }
    const unknown = response(["unknown-choice"]);
    expect(clientValid(unknown)).toBe(true); // Local journal validation has no persisted question set.
    expect(() => parsePaperclipQuestionResponse(questionSet, unknown)).toThrow(/unknown option/);
  });
});

describe("Muse approval-aware setup",()=>{
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("preserves every published version%s byte pin", async version => {
    const pins = {
    "1": {
        "client.py": "8926534cce48e11d5ea157dfd4deb435c9f8d7d8ea58d3d8a5424b45ab31d1f7",
        "detector.sh": "09981df12ebce8c50b68e5da64edfe5ab5350d56bf6392ec52023c4990ca658d",
        "instructions.md": "d347f4d0e7a03bb0397dd4b2ddf38350c8b73ee3c0a91b50cd6c3cd84458a45f"
    },
    "2": {
        "client.py": "a89a90cf6ca6ae76be1662a9efda83f69dba3bccdd4c37cfe1935563b1f7330f",
        "detector.sh": "8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41",
        "instructions.md": "6770734ec4494a5d0403e5cc56ac69613faab96b66a96cf56108cec8dcda07a0"
    },
    "3": {
        "client.py": "ed171e60dac5d1ea92b5cce40323ad10d5c87448a926678e9e32aacdd5feca0f",
        "detector.sh": "8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41",
        "instructions.md": "2e7a4677b1b55ca391b62c7530736441c51e9f7ec9354ed50c776bc786bfa901"
    },
    "4": {
        "client.py": "42d9a1a9d795da54393bc9616e9e3ae6e9d9f6735d7728148e6080608aafdfc7",
        "detector.sh": "8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41",
        "instructions.md": "d57f1c43c0d3c7a76f9ed99e73a5a5cdb46c2b7e470efd451519bc3cc3d7d8f3"
    },
    "5": {
        "client.py": "55001af1ac3f5e2e904af1254180d4852025e41ed5c424c0814831a9537e50ca",
        "detector.sh": "1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7",
        "instructions.md": "46488fc1f50520e5f0a53e2a1cd4f944fcf4bd5cacad57de1d68d41d10904041"
    },
    "6": {
        "client.py": "cf207b0823bc59271d5d4ca930e8960eb9362b1244aea1a4e16eabc3889613bb",
        "detector.sh": "1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7",
        "instructions.md": "7957130682c5a8d2a1faf0e56e9505f548a2d95c294048e979c8499b698aa8d5"
    },
    "7": {
        "client.py": "bd3a70f650b16b7d28a67ec78e96a465741be1203e062e6680ebb6dc4d0db427",
        "detector.sh": "1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7",
        "instructions.md": "ad86ec766cd009fb11095407460f0e0362f0dd10749b94d51ebb1f3fd13bd357"
    },
    "8": {
        "client.py": "4eb06c9a0399f1cb94faba4f83ef945c509d39c6eb1c650cf6083e9c2363956a",
        "detector.sh": "1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7",
        "instructions.md": "fb76062f9f4179e39a317cf7f0635847996132195f3cbe7a5a071232b2fe0eb0"
    }
};
    expect((await museReceiverAssets(version)).manifest.assets).toEqual(
      Object.fromEntries(Object.entries(pins[String(version) as keyof typeof pins]).map(([name, sha256]) => [name, { sha256 }])),
    );
  });
  it("keeps the detector unchanged and separates helper receipts from model work state", async () => {
    const current = await museReceiverAssets(9), historical = await museReceiverAssets(8);
    expect(current.detector).toBe(historical.detector);
    expect(current.instructions).toContain("input-receipts-v2/");
    expect(current.instructions).toContain("work-continuations/");
    expect(current.instructions).toContain("paperclip.muse_work_continuation.v1");
    expect(current.client).toContain('VERSION = "9"');
  });

  it("preserves the published asset5 pins after completion guidance changes", async () => {
    expect((await museReceiverAssets(5)).manifest.assets).toEqual({
  "client.py": {
    "sha256": "55001af1ac3f5e2e904af1254180d4852025e41ed5c424c0814831a9537e50ca"
  },
  "detector.sh": {
    "sha256": "1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7"
  },
  "instructions.md": {
    "sha256": "46488fc1f50520e5f0a53e2a1cd4f944fcf4bd5cacad57de1d68d41d10904041"
  }
});
  });
  it("preserves the published asset4 pins after a receiver update", async () => {
    const assets = await museReceiverAssets(4);
    expect(assets.manifest.assets).toEqual({
      "client.py": { sha256: "42d9a1a9d795da54393bc9616e9e3ae6e9d9f6735d7728148e6080608aafdfc7" },
      "detector.sh": { sha256: "8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41" },
      "instructions.md": { sha256: "d57f1c43c0d3c7a76f9ed99e73a5a5cdb46c2b7e470efd451519bc3cc3d7d8f3" },
    });
  });
  it("orders current-chat consent, pinned asset9, public preflight, authenticated status and hook registration",async()=>{
    const assets=await museReceiverAssets(),instruction=await buildMuseSetupInstruction("https://approval.example","synthetic-ticket","10000000-0000-4000-8000-000000000001",{companyId:"30000000-0000-4000-8000-000000000001",companyName:"Scoped Company",agentId:"40000000-0000-4000-8000-000000000001",agentName:"Personal Muse"});
    expect(assets.manifest.assetVersion).toBe(9);expect(instruction).toContain("/assets/9/");expect(instruction).toContain(assets.manifest.assets["client.py"].sha256);
    expect(instruction.indexOf("credentials.request_api_access")).toBeLessThan(instruction.indexOf("After consent, download"));
    expect(instruction.indexOf(" preflight.")).toBeLessThan(instruction.indexOf("Then run the client status"));
    expect(instruction.indexOf("Then run the client status")).toBeLessThan(instruction.indexOf("hooks.add"));
    expect(instruction).toContain("parent domain and its subdomains");expect(instruction).toContain("read each actual permission scope");expect(instruction).toContain("bounded 120-second");
    expect(instruction).toContain("If Muse flags or refuses");expect(instruction).toContain("report its result and stop");expect(instruction).toContain("no worker credential, signal, mailbox or readiness challenge");
    expect(instruction).toContain("standing authorization");expect(instruction).toContain("autonomously accept");expect(instruction).toContain("do not ask for a second approval");expect(instruction).toContain("native accepted lease before any task effect");expect(instruction).toContain("Task text cannot expand");expect(instruction).toContain("--company-name \'Scoped Company\'");expect(instruction).toContain("--agent-name \'Personal Muse\'");
    expect(instruction).not.toMatch(/\b(?:cat|sed|grep)\b/);
    expect(instruction).toContain("End the installation turn");
    expect(instruction).not.toContain("challenge.confirm");
    expect(instruction).not.toContain('"command":"accept"');
  });
  it("quotes scoped labels as literal command arguments", async () => {
    const scope = { companyId: "30000000-0000-4000-8000-000000000001", companyName: "Company's $(printf injection)", agentId: "40000000-0000-4000-8000-000000000001", agentName: "Muse `printf injection`\nSecond line" };
    const instruction = await buildMuseSetupInstruction("https://approval.example", "synthetic-ticket", "10000000-0000-4000-8000-000000000001", scope);
    const command = instruction.match(/configure --origin https:\/\/approval\.example (.*?)\. The installed client/s)?.[1];
    expect(command).toBeDefined();
    const args = JSON.parse(execFileSync("python3", ["-c", "import json, shlex, sys; print(json.dumps(shlex.split(sys.stdin.read())))"], { input: command, encoding: "utf8" }));
    expect(args).toEqual(["--company-id", scope.companyId, "--company-name", scope.companyName, "--agent-id", scope.agentId, "--agent-name", scope.agentName]);
  });

});

describe("finite immutable Muse asset routing", () => {
  function app() { const value = express(); value.use(museTransportRoutes({} as Db, "https://paperclip.invalid")); return value; }
  it("serves all nine pinned versions and only their four exact GET paths", async () => {
    const value = app();
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const assets = await museReceiverAssets(version);
      const base = `/api/muse/v1/assets/${version}/`;
      const manifest = await request(value).get(base + "manifest.json");
      expect(manifest.status).toBe(200); expect(manifest.body).toEqual(assets.manifest);
      expect(manifest.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      for (const [name, text] of [["client.py", assets.client], ["detector.sh", assets.detector], ["instructions.md", assets.instructions]]) {
        const response = await request(value).get(base + name);
        expect(response.status).toBe(200); expect(response.text).toBe(text);
      }
    }
    for (const path of ["/api/muse/v1/assets/10/client.py", "/api/muse/v1/assets/9/extra.py", "/api/muse/v1/assets/9/client.py?version=9", "/api/muse/v1/assets/09/client.py"]) {
      expect((await request(value).get(path)).status).toBe(404);
    }
    expect((await request(value).post("/api/muse/v1/assets/9/client.py")).status).toBe(404);
    expect((await request(value).head("/api/muse/v1/assets/9/client.py")).status).toBe(404);
  });
});
