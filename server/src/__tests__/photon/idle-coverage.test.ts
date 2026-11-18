import type { Db } from "@paperclipai/db";
import { photonIdleReadTransaction } from "../../services/chat-channels/imessage-photon/idle-incoming.js";
import { expect, it } from "vitest";
import { photonCoverageFingerprint, parsePhotonConfiguredCoverage } from "../../services/chat-channels/imessage-photon/idle-coverage.js";
import { parseIdleCapabilities } from "../../services/idle-incoming-wake-capability.js";
const binding = { version: 1 as const, instanceId: "instance", environment: "test" as const, companyId: "company", endpointId: "endpoint", connectionId: "connection",
  runtimeGeneration: 1, projectId: "project", lineId: "line", phoneNumber: "+15555550101", allocation: "dedicated" as const, credentialFingerprint: "a".repeat(64),
  bindingId: "photon-receiver:" + "b".repeat(64), intakeAfter: "2099-01-01T00:00:00.000Z", maxFrameBytes: 11534336 };
const authority = { binding, handoffId: "00000000-0000-4000-8000-000000000001", subject: "subject", deliveredThrough: 7 };

it("Photon proof uses closed constant-size fields and canonical authority rather than object property order", () => {
  const reversed = Object.fromEntries(Object.entries(binding).reverse()) as typeof binding;
  expect(photonCoverageFingerprint([authority])).toBe(photonCoverageFingerprint([{ ...authority, binding: reversed }]));
  const proof = parsePhotonConfiguredCoverage({ version: 1, instanceId: "instance", generation: "c".repeat(64), count: 1000, bindingsFingerprint: photonCoverageFingerprint([authority]) });
  expect(Buffer.byteLength(JSON.stringify(proof))).toBeLessThan(400); expect(JSON.stringify(proof)).not.toContain(binding.phoneNumber);
  expect(() => parsePhotonConfiguredCoverage({ ...proof, entries: [authority] })).toThrow();
  expect(() => parseIdleCapabilities({ incomingWake: { version: 1, ownerId: authority.handoffId, generation: "d".repeat(64), routes: ["photon-broker-events-v1"], photonBroker: proof } })).toThrow("generation");
});
it("Photon authority fingerprint refuses duplicate/partial/foreign tuples", () => {
  const other = { ...authority, binding: { ...binding, endpointId: "other" } };
  expect(() => photonCoverageFingerprint([authority, authority])).toThrow("Duplicate");
  expect(photonCoverageFingerprint([authority, other])).not.toBe(photonCoverageFingerprint([authority]));
  expect(photonCoverageFingerprint([authority])).not.toBe(photonCoverageFingerprint([{ ...authority, handoffId: "00000000-0000-4000-8000-000000000002" }]));
});

it("every actual nested authority query charges the shared64query/2second budget before execution", async () => {
  let executions = 0, charged = 0, now = 0;
  const remaining = () => { if (now >= 2000) throw new Error("sharedtimebudget"); return 2000 - now; };
  const beforeRead = async () => { remaining(); charged += 2; if (charged > 64) throw new Error("sharedquerybudget"); };
  const select = () => { const builder = { from: () => builder, where: () => builder,
    then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => { executions++; return Promise.resolve([]).then(resolve, reject); } }; return builder; };
  const raw = { select, selectDistinct: select, execute: async () => { executions++; return []; } } as unknown as Pick<Db, "select" | "execute">;
  const read = photonIdleReadTransaction(raw, { beforeRead, remaining });
  // The fluent stand-in models query execution only, not authorization success.
  const query = () => (read.select() as unknown as { from(v: string): PromiseLike<unknown[]> }).from("controlled-authority-row");
  for (let i = 0; i < 32; i++) await query();
  expect(charged).toBe(64); expect(executions).toBe(32);
  await expect(query()).rejects.toThrow("sharedquerybudget"); expect(executions).toBe(32);
  now = 2000; await expect(read.execute("controlled" as never)).rejects.toThrow("sharedtimebudget"); expect(executions).toBe(32);
  expect(() => read.update({} as never)).toThrow("readonly");
});
