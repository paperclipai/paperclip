import { describe, expect, it } from "vitest";
import {
  isLoopbackIpv4Hex,
  isLoopbackIpv6Hex,
  isWildcardHex,
  listenerFactsForPort,
  parseProcNetTable,
} from "./proc-listener.js";

// 42010 == 0xA41A. /proc stores IPv4 little-endian: 127.0.0.1 -> 0100007F.
const LOOPBACK_ROW = "   0: 0100007F:A41A 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 12345 1";
const WILDCARD_ROW = "   1: 00000000:A41A 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 12346 1";
const OTHERUID_ROW = "   2: 0100007F:A41A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12347 1";
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

describe("proc listener parsing", () => {
  it("classifies loopback vs wildcard addresses", () => {
    expect(isLoopbackIpv4Hex("0100007F")).toBe(true);
    expect(isLoopbackIpv4Hex("0101A8C0")).toBe(false); // 192.168.1.1
    expect(isWildcardHex("00000000")).toBe(true);
    // /proc/net/tcp6 stores ::1 little-endian per word: final word 0x1 -> "01000000".
    expect(isLoopbackIpv6Hex("00000000000000000000000001000000")).toBe(true);
    // The big-endian spelling must NOT match, or a non-loopback bind could slip through.
    expect(isLoopbackIpv6Hex("00000000000000000000000000000001")).toBe(false);
    expect(isLoopbackIpv6Hex("00000000000000000000000000000000")).toBe(false); // ::
  });

  it("reports a loopback listener owned by the expected uid", () => {
    const rows = parseProcNetTable(`${HEADER}\n${LOOPBACK_ROW}`);
    const facts = listenerFactsForPort(rows, [], 42010);
    expect(facts.present).toBe(true);
    expect(facts.loopbackOnly).toBe(true);
    expect(facts.uids).toEqual([999]);
  });

  it("flags a wildcard bind as not loopback-only", () => {
    const rows = parseProcNetTable(`${HEADER}\n${WILDCARD_ROW}`);
    const facts = listenerFactsForPort(rows, [], 42010);
    expect(facts.present).toBe(true);
    expect(facts.loopbackOnly).toBe(false);
  });

  it("surfaces a foreign uid so ownership fails", () => {
    const rows = parseProcNetTable(`${HEADER}\n${OTHERUID_ROW}`);
    const facts = listenerFactsForPort(rows, [], 42010);
    expect(facts.uids).toEqual([1000]);
  });

  it("returns absent when no listener matches the port", () => {
    const rows = parseProcNetTable(`${HEADER}\n${LOOPBACK_ROW}`);
    expect(listenerFactsForPort(rows, [], 40000).present).toBe(false);
  });
});
