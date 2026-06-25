import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfileAgent = readFileSync(path.join(repoRoot, "Dockerfile.agent"), "utf8");

describe("paperclip agent Dockerfile", () => {
  it("strips inherited local ccrotate before installing agent tooling", () => {
    const stripIndex = dockerfileAgent.indexOf("rm -f /usr/local/bin/ccrotate");
    const firstAptInstallIndex = dockerfileAgent.indexOf("apt-get install -y --no-install-recommends");

    expect(stripIndex).toBeGreaterThan(-1);
    expect(firstAptInstallIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeLessThan(firstAptInstallIndex);
    expect(dockerfileAgent).toContain("find /usr/local/lib/node_modules -maxdepth 2");
  });

  it("fails the image build if ccrotate is still on the final node-user PATH", () => {
    const userNodeIndex = dockerfileAgent.lastIndexOf("USER node");
    const finalAssertion = dockerfileAgent.slice(userNodeIndex);

    expect(userNodeIndex).toBeGreaterThan(-1);
    expect(finalAssertion).toContain("command -v ccrotate");
    expect(finalAssertion).toContain("local ccrotate CLI leaked into paperclip-agent image");
    expect(finalAssertion).toContain("exit 1");
  });

  it("bakes the full Go toolchain (go, gofmt, tinygo) onto PATH", () => {
    // Go + gofmt symlinked into /usr/local/bin (on PATH for the node user).
    // Pinned to 1.25.6 to match CI / multicast; older versions made agents
    // self-install go1.25.6 into the PVC home and shadow the image.
    expect(dockerfileAgent).toContain("ARG GO_VERSION=1.25.6");
    expect(dockerfileAgent).toContain("ln -s /usr/local/go/bin/go /usr/local/bin/go");
    expect(dockerfileAgent).toContain("ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt");

    // TinyGo (WASM / embedded Go). Pinned + self-checked so a broken
    // version/URL fails the image build instead of shipping a toolchain gap.
    expect(dockerfileAgent).toContain("ARG TINYGO_VERSION=");
    expect(dockerfileAgent).toMatch(/tinygo_\$\{TINYGO_VERSION\}_amd64\.deb/);
    expect(dockerfileAgent).toContain("tinygo version");

    // tinygo shells out to `go`, so its install must come after the Go block.
    expect(dockerfileAgent.indexOf("ARG GO_VERSION=")).toBeLessThan(
      dockerfileAgent.indexOf("ARG TINYGO_VERSION="),
    );
  });
});
