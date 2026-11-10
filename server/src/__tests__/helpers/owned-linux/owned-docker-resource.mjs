// PRIVATE UNRUN concrete local resource owner. No daemon setup/pull/config
// changes. Requires an already-qualified image, Node and Linux Runner artifact.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, realpath, readdir } from "node:fs/promises";

const digest = value => createHash("sha256").update(value).digest("hex");
const closed = code => Object.assign(new Error(code), { code });
export class OwnedDockerResources {
  constructor(config) {
    this.config = config; this.pending = new Set(); this.commands = []; this.resources = new Map(); this.unknown = [];
  }
  async initialize() {
    const engine = await this.cli(["info", "--format", "{{.ID}} {{.OSType}} {{.Architecture}}"]);
    if (engine.code !== 0 || engine.stdout.trim() !== `${this.config.engineId} linux aarch64`) throw closed("owned_engine_identity_drift");
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    if (await realpath(this.config.root) !== this.config.root) throw closed("owned_resource_root_denied");
    const names = (await readdir(this.config.root)).filter(name => /^dot-linux-[a-f0-9]{24}$/.test(name));
    if (names.length > 32) throw closed("owned_resource_inventory_overflow");
    // One bounded owned-directory reconstruction, no periodic scan or Docker
    // global inventory. Lost replies retain actual allocation identity.
    for (const name of names) {
      const resource = JSON.parse(await readFile(path.join(this.config.root, name, "resource.json"), "utf8"));
      if (resource.id !== name || resource.hostRoot !== path.join(this.config.root, name)) throw closed("owned_reconstruction_scope_denied");
      const actual = await this.inspect(resource);
      if (resource.status === "stopped" && (actual.State.Running || actual.State.Pid !== 0)) throw closed("owned_retirement_reconstruction_mismatch");
      if (resource.status === "resume_intent" && actual.State.Running && actual.State.Pid > 0) {
        resource.status = "active"; await this.save(resource);
      }
      if (resource.status !== "active" && resource.status !== "stopped") { this.unknown.push({ resourceId: name, kind: "allocation_outcome_unknown" }); continue; }
      this.resources.set(name, resource);
    }
  }
  async cli(args, input, timeoutMs = 15000) {
    const child = spawn(this.config.docker, ["--host", this.config.endpoint, ...args], {
      env: { HOME: this.config.home, DOCKER_CONFIG: this.config.dockerConfig, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    const record = { pid: child.pid ?? null, group: child.pid ?? null, joined: false, timedOut: false, overflow: false };
    this.commands.push(record); this.pending.add(record);
    const stdout = [], stderr = []; let bytes = 0;
    const collect = output => chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { record.overflow = true; return; } output.push(chunk); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    let spawnFailed = false; child.once("error", () => { spawnFailed = true; });
    const joined = new Promise(resolve => child.once("close", (code, signal) => { Object.assign(record, { joined: true, code, signal }); this.pending.delete(record); resolve(); }));
    child.stdin.on("error", () => {}); child.stdin.end(input);
    const timer = setTimeout(() => { record.timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    await joined; clearTimeout(timer);
    if (spawnFailed || record.timedOut || record.overflow) { this.unknown.push(record); throw closed("owned_docker_transport_unknown"); }
    // Raw output stays in memory/normal protocol; never log argv/input/error body.
    return { code: record.code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  }
  async inspect(resource) {
    const response = await this.cli(["inspect", "--format", '{{json .}}', resource.containerId ?? resource.containerName]);
    if (response.code !== 0) throw closed("owned_container_inspection_unknown");
    const value = JSON.parse(response.stdout), labels = value.Config?.Labels ?? {};
    if (value.Name !== "/" + resource.containerName || value.Image !== this.config.imageId
        || labels["paperclip.qualification"] !== this.config.namespace || labels["paperclip.resource"] !== resource.id
        || labels["paperclip.company"] !== resource.companyId || labels["paperclip.environment"] !== resource.environmentId
        || labels["paperclip.run"] !== resource.runId || labels["paperclip.creation"] !== resource.creationOperationId
        || value.HostConfig?.Privileged || value.HostConfig?.NetworkMode !== "none"
        || value.HostConfig?.NanoCpus !== 2000000000 || value.HostConfig?.Memory !== 4294967296
        || value.HostConfig?.PidsLimit !== 256 || !value.HostConfig?.Init) throw closed("owned_container_identity_mismatch");
    if (resource.containerId && value.Id !== resource.containerId) throw closed("owned_container_replaced");
    return value;
  }
  async save(resource) {
    const target = path.join(resource.hostRoot, "resource.json"), temporary = target + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(resource), { flag: "wx", mode: 0o600 }); await rename(temporary, target);
  }
  async acquire(params) {
    if (!/^sha256:[a-f0-9]{64}$/.test(this.config.imageId) || !/^[a-f0-9]{64}$/.test(this.config.runnerSHA256)
        || digest(await readFile(this.config.nodeBinary)) !== this.config.nodeSHA256
        || await realpath(this.config.root) !== this.config.root || await realpath(this.config.relayRoot) !== this.config.relayRoot) throw closed("owned_runtime_prerequisite_unqualified");
    if (params.driverKey !== "dot-linux-qualification" || params.config.qualificationId !== "dot-owned-linux"
        || !params.creationOperationId || !params.runId || params.purpose === "login" || params.requestedExpiresAt) throw closed("owned_allocation_scope_denied");
    // One normal creation operation => one name/resource, even after a lost
    // acquire reply. Never mint a second allocation on an unknown outcome.
    const id = "dot-linux-" + digest(JSON.stringify([params.companyId, params.environmentId, params.runId, params.creationOperationId])).slice(0, 24);
    const hostRoot = path.join(this.config.root, id); await mkdir(hostRoot, { recursive: true, mode: 0o700 });
    if (await realpath(hostRoot) !== hostRoot) throw closed("owned_resource_path_denied");
    let resource;
    try { resource = JSON.parse(await readFile(path.join(hostRoot, "resource.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (resource) {
      if (resource.companyId !== params.companyId || resource.environmentId !== params.environmentId || resource.runId !== params.runId
          || resource.creationOperationId !== params.creationOperationId) throw closed("owned_creation_custody_mismatch");
      const actual = await this.inspect(resource);
      if (!actual.State.Running || resource.status !== "active") throw closed("owned_creation_not_resumable");
      this.resources.set(id, resource); return resource;
    }
    resource = { id, hostRoot, root: "/workspace", companyId: params.companyId, environmentId: params.environmentId,
      runId: params.runId, creationOperationId: params.creationOperationId, nonce: randomUUID(), containerName: id,
      containerId: null, status: "dispatch_recorded", expectedRunnerSHA256: this.config.runnerSHA256,
      launchDescriptor: "/workspace/.qualification-custody/active-launch.json" };
    await this.save(resource); // durable before creating anything
    for (const name of ["workspace", "descriptor"]) await mkdir(path.join(hostRoot, name), { mode: 0o700 });
    const args = ["create", "--name", id, "--init", "--read-only", "--network", "none", "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${this.config.uid}:${this.config.gid}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456"];
    for (const [key, value] of Object.entries({ qualification: this.config.namespace, resource: id, company: params.companyId,
      environment: params.environmentId, run: params.runId, creation: params.creationOperationId })) args.push("--label", `paperclip.${key}=${value}`);
    for (const [source, destination, readonly] of [[path.join(hostRoot, "workspace"), "/workspace", false],
      [path.join(hostRoot, "descriptor"), "/descriptor", true], [this.config.relayRoot, "/qualification", true], [this.config.nodeBinary, "/usr/bin/node", true]]) {
      args.push("--mount", `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`);
    }
    args.push(this.config.imageId, "sleep", "infinity");
    const created = await this.cli(args);
    if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(created.stdout.trim())) throw closed("owned_creation_unknown_retained");
    resource.containerId = created.stdout.trim(); await this.save(resource); await this.inspect(resource);
    await writeFile(path.join(hostRoot, "descriptor/resource.json"), JSON.stringify(resource), { flag: "wx", mode: 0o600 });
    const started = await this.cli(["start", resource.containerId]); if (started.code !== 0) throw closed("owned_start_unknown_retained");
    const actual = await this.inspect(resource); if (!actual.State.Running) throw closed("owned_start_not_observed");
    resource.status = "active"; await this.save(resource); this.resources.set(id, resource); return resource;
  }
  async resolve(params, providerLeaseId) {
    if (!/^dot-linux-[a-f0-9]{24}$/.test(providerLeaseId)) throw closed("owned_lease_identity_invalid");
    const resource = this.resources.get(providerLeaseId);
    // Reconstruct from durable allocation, not a synthetic in-memory success.
    const found = resource ?? JSON.parse(await readFile(path.join(this.config.root, providerLeaseId, "resource.json"), "utf8"));
    if (!/^dot-linux-[a-f0-9]{24}$/.test(providerLeaseId) || found.id !== providerLeaseId
        || found.companyId !== params.companyId || found.environmentId !== params.environmentId) throw closed("owned_lease_authority_denied");
    await this.inspect(found); this.resources.set(found.id, found); return found;
  }
  async resume(params) {
    const resource = await this.resolve(params, params.providerLeaseId);
    if (params.runId && params.runId !== resource.runId) throw closed("owned_resume_run_authority_mismatch");
    if (params.requestedCwd && params.requestedCwd !== resource.root) throw closed("owned_resume_workspace_mismatch");
    const actual = await this.inspect(resource);
    if (!actual.State.Running) {
      if (actual.State.Pid !== 0 || resource.status !== "stopped" || this.pending.size || this.unknown.length)
        throw closed("owned_resume_previous_execution_unknown");
      // Retain the previous launch witness before a new launch can own this
      // exact workspace. Container stop proved the whole prior PID namespace
      // ended. Do not delete a marker/checkpoint or acquire a replacement.
      const custody = path.join(resource.hostRoot, "workspace/.qualification-custody");
      const active = path.join(custody, "active-launch.json");
      try { await rename(active, path.join(custody, "retired-launch-" + randomUUID() + ".json")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      resource.status = "resume_intent"; await this.save(resource);
      const started = await this.cli(["start", resource.containerId]);
      if (started.code !== 0) throw closed("owned_resume_transport_unknown_retained");
    } else if (resource.status !== "active") {
      // Lost resume response is reconciled only for the exact durable intent.
      if (resource.status !== "resume_intent") throw closed("owned_resume_state_unknown");
    }
    const observed = await this.inspect(resource);
    if (!observed.State.Running || observed.State.Pid <= 0) throw closed("owned_resume_not_observed_retained");
    resource.status = "active"; await this.save(resource); return resource;
  }
  async stop(resource) {
    // The normal fixture MUST close Runner/ingress first. Exact container stop
    // is an execution-termination boundary, not a claim of graceful PID join.
    if (this.pending.size || this.unknown.length) throw closed("owned_calls_or_outcomes_unknown_retained");
    const current = await this.inspect(resource);
    if (current.State.Running) {
      const stopped = await this.cli(["stop", "--time", "15", resource.containerId], undefined, 30000);
      if (stopped.code !== 0) throw closed("owned_stop_unknown_retained");
    }
    const actual = await this.inspect(resource);
    if (actual.State.Running || actual.State.Pid !== 0) throw closed("owned_stop_not_observed_retained");
    resource.status = "stopped"; resource.namespaceTerminationOnly = true; await this.save(resource);
    return { providerLeaseId: resource.id, state: "stopped" };
  }
}
