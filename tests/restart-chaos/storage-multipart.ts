import type { StorageFault, StorageFaultRule } from "./storage-proxy.js";

export const SNAPSHOT_PATH = "workspace-snapshots";
const MIB = 1024 * 1024;

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export function multipartFaultRules(random: () => number): StorageFaultRule[] {
  const parts = [1, 2, 3, 4].filter(() => random() < 0.5);
  if (!parts.length) parts.push(1 + Math.floor(random() * 4));
  const remaining = random() < 0.5 ? 1 + Math.floor(random() * 3) : undefined;
  const partFault: StorageFault = pick<StorageFault>(random, [
    { kind: "errors", rate: 1, status: pick(random, [500, 503]) },
    { kind: "reset" },
    { kind: "truncate", afterBytes: (1 + Math.floor(random() * 4)) * MIB },
  ]);
  const rules: StorageFaultRule[] = [{ fault: partFault, operations: ["UploadPart"], partNumbers: parts, pathIncludes: SNAPSHOT_PATH,
    ...(remaining === undefined ? {} : { remaining }) }];
  if (random() < 0.5) {
    rules.push({ fault: pick<StorageFault>(random, [{ kind: "errors", rate: 1, status: 500 }, { kind: "reset" }]),
      operations: ["CompleteMultipartUpload"], pathIncludes: SNAPSHOT_PATH, remaining: 1 + Math.floor(random() * 2) });
  }
  return rules;
}
