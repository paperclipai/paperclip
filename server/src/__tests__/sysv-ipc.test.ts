import { describe, expect, it } from "vitest";
import {
  findOrphanedSysvSharedMemoryIds,
  parseIpcsSharedMemoryProcessTable,
} from "../lib/sysv-ipc.js";

describe("parseIpcsSharedMemoryProcessTable", () => {
  it("parses macOS ipcs -m -p output", () => {
    const output = `IPC status from <running system> as of Sun Apr 12 23:09:12 CEST 2026
T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID
Shared Memory:
m  65536 0x00000000 --rw-------      seb    staff   1664   1664
m 39387137 0x0bf88179 --rw-------      seb    staff  31342      0
`;

    expect(parseIpcsSharedMemoryProcessTable(output)).toEqual([
      { id: "65536", owner: "seb", creatorPid: 1664, lastOperatorPid: 1664 },
      { id: "39387137", owner: "seb", creatorPid: 31342, lastOperatorPid: 0 },
    ]);
  });
});

describe("findOrphanedSysvSharedMemoryIds", () => {
  it("returns only current-user segments whose creator and last-op pids are dead", () => {
    const rows = parseIpcsSharedMemoryProcessTable(`IPC status from <running system>
T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID
Shared Memory:
m  65536 0x00000000 --rw-------      seb    staff   1664   1664
m 39387137 0x0bf88179 --rw-------      seb    staff  31342      0
m 35323906 0x0bf86548 --rw-------      alex   staff  26645      0
`);

    const orphaned = findOrphanedSysvSharedMemoryIds(rows, "seb", (pid) => pid === 1664);

    expect(orphaned).toEqual(["39387137"]);
  });
});
