import { appendFileSync, readFileSync } from "node:fs";

const sandboxes = new Map();
let nextId = 0;

function record(event, fields = {}) {
  appendFileSync(process.env.PAPERCLIP_DAYTONA_FIXTURE_JOURNAL, `${JSON.stringify({ event, ...fields })}\n`);
}

function sandbox(params) {
  const id = `fixture-sandbox-${++nextId}`;
  const files = new Map();
  const resource = {
    id,
    name: params.name,
    labels: params.labels,
    state: "started",
    target: "us",
    autoDeleteInterval: -1,
    async getWorkDir() { return "/home/daytona"; },
    async getUserHomeDir() { return "/home/daytona"; },
    async refreshData() {},
    async setTtl() {},
    async setAutoDeleteInterval(value) { resource.autoDeleteInterval = value; },
    async start() { resource.state = "started"; record("start", { id }); },
    async stop() { resource.state = "stopped"; record("stop", { id }); },
    async delete() { sandboxes.delete(id); record("delete", { id }); },
    fs: {
      async createFolder() {},
      async uploadFile(content, destination) { files.set(destination, content.toString("utf8")); },
      async deleteFile() {},
    },
    process: {
      async executeCommand(command) {
        const afterRelease = command.includes("monitor-after-release");
        record("execute", { id, afterRelease });
        if (command.includes("fixture-provider-stop")) resource.state = "stopped";
        const sentinel = command.match(/^cat '([^']+)'/);
        const result = afterRelease ? readFileSync(process.env.PAPERCLIP_DAYTONA_FIXTURE_SAVED_FILE, "utf8")
          : sentinel ? files.get(sentinel[1]) ?? "" : "bash";
        return { exitCode: 0, result, artifacts: { stdout: result } };
      },
      async createPty() {
        let finish;
        const exited = new Promise(resolve => { finish = resolve; });
        record("pty.open", { id });
        return {
          async waitForConnection() {},
          async sendInput() { record("pty.write", { id }); },
          wait() { return exited; },
          async kill() { record("pty.kill", { id }); finish({ exitCode: 0 }); },
          async disconnect() {
            record("pty.disconnect", { id });
            if (process.env.PAPERCLIP_DAYTONA_FIXTURE_HANG_CLOSE === "1" && id === "fixture-sandbox-1") {
              await new Promise(() => {});
            }
          },
        };
      },
    },
  };
  sandboxes.set(id, resource);
  record("create", { id });
  return resource;
}

export class Daytona {
  async create(params) { return sandbox(params); }
  async get(id) {
    const result = sandboxes.get(id);
    if (!result) throw new DaytonaNotFoundError("Fixture sandbox is absent");
    return result;
  }
}

export class DaytonaNotFoundError extends Error {}
export class DaytonaTimeoutError extends Error {}
