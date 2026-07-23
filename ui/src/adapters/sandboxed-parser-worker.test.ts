import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    expect(source).toContain('shadow("Worker")');
    expect(source).toContain('shadow("SharedWorker")');
    expect(source).toContain('shadow("Blob")');
    expect(source).toContain('shadow("RTCPeerConnection")');
    expect(source).toContain('shadow("RTCDataChannel")');
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });

  it("implements robust, non-deletable prototype-walking shadow mechanism", () => {
    const source = getWorkerBootstrapSource();
    expect(source).toContain("Object.getPrototypeOf");
    expect(source).toContain("configurable: false");
    expect(source).toContain("writable: false");
  });
});
