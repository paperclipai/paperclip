import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCliCommandLabel } from "./command-label.js";

describe("buildCliCommandLabel", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("returns 'paperclipai' with no args", () => {
    process.argv = ["node", "cli.js"];
    expect(buildCliCommandLabel()).toBe("paperclipai");
  });

  it("returns 'paperclipai' plus the subcommand when args are present", () => {
    process.argv = ["node", "cli.js", "start"];
    expect(buildCliCommandLabel()).toBe("paperclipai start");
  });

  it("joins multiple args with spaces", () => {
    process.argv = ["node", "cli.js", "agent", "create", "--name", "my-agent"];
    expect(buildCliCommandLabel()).toBe("paperclipai agent create --name my-agent");
  });
});
