import http, { request as requestHttp } from "node:http";

const socketPath = "/var/run/docker.sock";
const port = 2375;
const postgresImage = "postgres:17-alpine";
const apiNetwork = "docker_docker-api";
const postgresPort = "5432/tcp";
const containerTtlMs = 14 * 60 * 1000;
const cleanupIntervalMs = 5 * 1000;
const scopeLabel = "com.trinity.paperclip.proxy-scope";
const createdLabel = "com.trinity.paperclip.proxy-created-at";
const scopeValue = "tri32-postgres";
const allowedContainers = new Map();
const allowedEnvironmentKeys = new Set(["POSTGRES_PASSWORD", "POSTGRES_USER", "POSTGRES_DB"]);
let lastSuccessfulSweepAt = 0;
const defaultEntrypoint = ["docker-entrypoint.sh"];
const defaultCommand = ["postgres"];

function isDefaultCommand(value, expected) {
  return value == null || (Array.isArray(value) && value.length === expected.length && value.every((part, index) => part === expected[index]));
}

function isAllowedPostgresCommand(value) {
  if (isDefaultCommand(value, defaultCommand)) return true;
  const testcontainersPostgresCommand = [
    "-c", "fsync=off",
    "-c", "full_page_writes=off",
    "-c", "synchronous_commit=off",
  ];
  return Array.isArray(value) && value.length === testcontainersPostgresCommand.length &&
    value.every((part, index) => part === testcontainersPostgresCommand[index]);
}

function apiPath(pathname) {
  return pathname.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, "") || "/";
}

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ message }));
}

function imageAllowed(reference) {
  return reference === postgresImage || reference === "docker.io/library/postgres:17-alpine";
}

function containerIdFromPath(path) {
  return path.match(/^\/containers\/([a-f0-9]{12,64})(?:\/(json|start|stop|wait|logs))?$/);
}

function validateContainer(config) {
  if (!imageAllowed(config?.Image)) return "Only postgres:17-alpine is allowed.";
  if (!isDefaultCommand(config.Entrypoint, defaultEntrypoint)) {
    return "PostgreSQL entrypoint overrides are not allowed.";
  }
  if (!isAllowedPostgresCommand(config.Cmd)) {
    return "PostgreSQL command overrides are not allowed.";
  }
  if ((config.WorkingDir != null && config.WorkingDir !== "") || (config.User != null && config.User !== "")) {
    return "Container working-directory and user overrides are not allowed.";
  }
  if (config.Healthcheck) return "Container health-check overrides are not allowed.";

  const requestedVolumes = config.Volumes ?? {};
  if (Object.keys(requestedVolumes).some((name) => name !== "/var/lib/postgresql/data")) {
    return "Only the PostgreSQL image's disposable data volume is allowed.";
  }

  const env = config.Env ?? [];
  if (!Array.isArray(env) || env.some((entry) => {
    const separator = typeof entry === "string" ? entry.indexOf("=") : -1;
    return separator < 1 || !allowedEnvironmentKeys.has(entry.slice(0, separator));
  })) {
    return "Only PostgreSQL initialization environment variables are allowed.";
  }
  if (!env.some((entry) => entry.startsWith("POSTGRES_PASSWORD=") && entry.length > "POSTGRES_PASSWORD=".length)) {
    return "A non-empty PostgreSQL password is required.";
  }

  const exposedPorts = Object.keys(config.ExposedPorts ?? {});
  if (exposedPorts.length !== 1 || exposedPorts[0] !== postgresPort) {
    return "Only PostgreSQL test port 5432/tcp may be exposed.";
  }

  const host = config.HostConfig ?? {};
  const networkMode = host.NetworkMode;
  if (networkMode && ![apiNetwork, "docker-api", "bridge", "default"].includes(networkMode)) {
    return "Only the internal docker-api network is allowed.";
  }
  const bindings = host.PortBindings ?? {};
  for (const key of Object.keys(bindings)) {
    if (key !== postgresPort) return "Only PostgreSQL test port 5432/tcp may be bound.";
  }
  const portBindings = bindings[postgresPort] ?? [];
  if (!Array.isArray(portBindings) || portBindings.length > 1) {
    return "At most one temporary PostgreSQL test-port binding is allowed.";
  }
  if (portBindings.length === 1) {
    const binding = portBindings[0] ?? {};
    if (!(["", "0"].includes(String(binding.HostPort ?? ""))) || binding.HostIp !== "127.0.0.1") {
      return "PostgreSQL test port must use an ephemeral loopback-only host binding.";
    }
  }

  if (host.Privileged) return "Privileged containers are not allowed.";
  if (host.CapAdd?.length || host.CapDrop?.length) return "Container capability changes are not allowed.";
  if (host.Devices?.length || host.DeviceRequests?.length) return "Device access is not allowed.";
  if (host.Mounts?.length || host.Binds?.length) return "Container mounts are not allowed.";
  if (host.VolumesFrom?.length) return "Container volume sharing is not allowed.";
  if (host.PidMode || host.IpcMode || host.UTSMode || host.CgroupnsMode) return "Host namespace sharing is not allowed.";
  if (host.Links?.length || host.ContainerIDFile) return "Container links and host-managed container paths are not allowed.";
  if (host.SecurityOpt?.length) return "Container security option changes are not allowed.";
  if (host.Sysctls && Object.keys(host.Sysctls).length) return "Container sysctl changes are not allowed.";
  if (host.ExtraHosts?.length || host.Dns?.length || host.DnsOptions?.length || host.DnsSearch?.length) {
    return "Container host and DNS overrides are not allowed.";
  }
  if (host.CgroupParent || host.PidFile) return "Host-managed container paths are not allowed.";
  if (host.Runtime && host.Runtime !== "runc") return "Alternate container runtimes are not allowed.";
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== "no") return "Persistent restart policies are not allowed.";
  if (host.AutoRemove) return "Proxy-managed cleanup is required; Docker auto-remove is not allowed.";

  const networkEndpoints = config.NetworkingConfig?.EndpointsConfig ?? {};
  if (Object.keys(networkEndpoints).some((name) => ![apiNetwork, "docker-api", "bridge", "default"].includes(name))) {
    return "Only the internal docker-api network is allowed.";
  }

  return null;
}

function daemonRequest(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) };
    const request = requestHttp({ socketPath, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 502,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function removeContainer(id, state) {
  try {
    if (state === "running") await daemonRequest(`/containers/${id}/stop?t=5`, "POST");
    const result = await daemonRequest(`/containers/${id}?force=true&v=true`, "DELETE");
    if ([200, 204, 404].includes(result.statusCode)) allowedContainers.delete(id);
  } catch (error) {
    console.error(`PostgreSQL test-container cleanup failed for ${id.slice(0, 12)}: ${error.code ?? error.message}`);
  }
}

let cleanupRunning = false;
async function sweepExpiredContainers() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${scopeLabel}=${scopeValue}`] }));
    const response = await daemonRequest(`/containers/json?all=1&filters=${filters}`);
    if (response.statusCode !== 200) throw new Error(`Docker list returned ${response.statusCode}`);
    const containers = JSON.parse(response.body);
    const now = Date.now();
    const seen = new Set();
    for (const container of containers) {
      const labels = container.Labels ?? {};
      if (labels[scopeLabel] !== scopeValue) continue;
      const id = container.Id;
      if (!id) continue;
      seen.add(id);
      const createdAt = Number(container.Created) * 1000 || Number(labels[createdLabel]) || now;
      allowedContainers.set(id, createdAt);
      if (now - createdAt >= containerTtlMs) await removeContainer(id, container.State);
    }
    for (const id of allowedContainers.keys()) {
      if (!seen.has(id)) allowedContainers.delete(id);
    }
    lastSuccessfulSweepAt = now;
  } catch (error) {
    console.error(`PostgreSQL test-container sweep failed: ${error.code ?? error.message}`);
  } finally {
    cleanupRunning = false;
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://docker-proxy");
  const path = apiPath(url.pathname);
  const method = request.method ?? "GET";

  const isPing = method === "GET" && path === "/_ping";
  const isVersion = method === "GET" && path === "/version";
  const isInfo = method === "GET" && path === "/info";
  const isImagesList = method === "GET" && path === "/images/json";
  const imageInspect = path.match(/^\/images\/([^/]+)\/json$/);
  const isImageInspect = method === "GET" && imageInspect !== null && imageAllowed(decodeURIComponent(imageInspect[1]));
  const isImagePull = method === "POST" && path === "/images/create";
  const isContainersList = method === "GET" && path === "/containers/json";
  const isContainerCreate = method === "POST" && path === "/containers/create";
  const containerAction = containerIdFromPath(path);
  const containerId = containerAction?.[1];
  const knownContainer = containerId && [...allowedContainers.keys()].some((id) => id.startsWith(containerId) || containerId.startsWith(id));
  const isKnownContainerPath = Boolean(knownContainer && containerAction);
  const isContainerInspect = method === "GET" && isKnownContainerPath && containerAction[2] === "json";
  const isContainerStart = method === "POST" && isKnownContainerPath && containerAction[2] === "start";
  const isContainerStop = method === "POST" && isKnownContainerPath && containerAction[2] === "stop";
  const isContainerWait = method === "POST" && isKnownContainerPath && containerAction[2] === "wait";
  const isContainerLogs = method === "GET" && isKnownContainerPath && containerAction[2] === "logs";
  const isContainerDelete = method === "DELETE" && isKnownContainerPath && containerAction[2] === undefined;
  const allowed = isPing || isVersion || isInfo || isImagesList || isImageInspect || isImagePull ||
    isContainersList || isContainerCreate || isContainerInspect || isContainerStart ||
    isContainerStop || isContainerWait || isContainerLogs || isContainerDelete;

  if (!allowed) {
    request.resume();
    return sendError(response, 403, "Docker API operation is not allowed by the Paperclip runner proxy.");
  }

  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) {
      request.destroy();
      if (!response.headersSent) sendError(response, 413, "Docker API request body exceeds 1 MiB.");
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    const body = Buffer.concat(chunks);
    let createConfig;
    if (isImagePull) {
      const image = url.searchParams.get("fromImage");
      const tag = url.searchParams.get("tag");
      const imageRef = image && tag && !image.slice(image.lastIndexOf("/") + 1).includes(":") ? `${image}:${tag}` : image;
      if (!imageAllowed(imageRef)) return sendError(response, 403, "Only postgres:17-alpine may be pulled for this test harness.");
    }
    if (isContainerCreate) {
      if (Date.now() - lastSuccessfulSweepAt > 60 * 1000) {
        return sendError(response, 503, "PostgreSQL cleanup enforcement is not ready.");
      }
      try {
        createConfig = JSON.parse(body.toString("utf8"));
      } catch {
        return sendError(response, 400, "Container create request must contain valid JSON.");
      }
      const violation = validateContainer(createConfig);
      if (violation) return sendError(response, 403, violation);
      if (createConfig.Labels != null && (typeof createConfig.Labels !== "object" || Array.isArray(createConfig.Labels))) {
        return sendError(response, 400, "Container labels must be an object.");
      }
      createConfig.HostConfig ??= {};
      createConfig.HostConfig.NetworkMode = apiNetwork;
      delete createConfig.NetworkingConfig;
      createConfig.HostConfig.RestartPolicy = { Name: "no" };
      createConfig.HostConfig.AutoRemove = false;
      createConfig.HostConfig.PublishAllPorts = false;
      createConfig.HostConfig.Memory = 512 * 1024 * 1024;
      createConfig.HostConfig.MemorySwap = 512 * 1024 * 1024;
      createConfig.HostConfig.NanoCpus = 1_000_000_000;
      createConfig.HostConfig.PidsLimit = 128;
      createConfig.HostConfig.LogConfig = { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } };
      createConfig.Labels ??= {};
      createConfig.Labels[scopeLabel] = scopeValue;
      createConfig.Labels[createdLabel] = String(Date.now());
    }

    const outgoingBody = isContainerCreate ? Buffer.from(JSON.stringify(createConfig)) : body;
    const headers = { ...request.headers, host: "docker", "accept-encoding": "identity" };
    delete headers["transfer-encoding"];
    delete headers.expect;
    headers["content-length"] = String(outgoingBody.length);
    const outgoingPath = isContainerDelete
      ? `${url.pathname}?force=true&v=true`
      : request.url;
    const upstream = requestHttp({ socketPath, path: outgoingPath, method, headers }, (dockerResponse) => {
      if (isContainerCreate || isContainersList || isImagesList) {
        const responseChunks = [];
        dockerResponse.on("data", (chunk) => responseChunks.push(chunk));
        dockerResponse.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          let output = responseBody;
          if (isContainerCreate && dockerResponse.statusCode >= 200 && dockerResponse.statusCode < 300) {
            try {
              const created = JSON.parse(responseBody.toString("utf8"));
              if (created.Id) allowedContainers.set(created.Id, Date.now());
            } catch {
              return sendError(response, 502, "Docker returned an invalid container create response.");
            }
          }
          if (isContainersList && dockerResponse.statusCode >= 200 && dockerResponse.statusCode < 300) {
            try {
              const listed = JSON.parse(responseBody.toString("utf8"));
              output = Buffer.from(JSON.stringify(listed.filter((container) =>
                [...allowedContainers.keys()].some((id) => id.startsWith(container.Id) || container.Id.startsWith(id)),
              )));
            } catch {
              return sendError(response, 502, "Docker returned an invalid container list.");
            }
          }
          if (isImagesList && dockerResponse.statusCode >= 200 && dockerResponse.statusCode < 300) {
            try {
              const listed = JSON.parse(responseBody.toString("utf8"));
              output = Buffer.from(JSON.stringify(listed.filter((image) =>
                (image.RepoTags ?? []).some(imageAllowed),
              )));
            } catch {
              return sendError(response, 502, "Docker returned an invalid image list.");
            }
          }
          const responseHeaders = { ...dockerResponse.headers, "content-length": String(output.length) };
          delete responseHeaders["transfer-encoding"];
          response.writeHead(dockerResponse.statusCode ?? 502, responseHeaders);
          response.end(output);
          if (isContainerDelete && dockerResponse.statusCode >= 200 && dockerResponse.statusCode < 300) {
            for (const id of allowedContainers.keys()) {
              if (id.startsWith(containerId) || containerId.startsWith(id)) allowedContainers.delete(id);
            }
          }
        });
      } else {
        response.writeHead(dockerResponse.statusCode ?? 502, dockerResponse.headers);
        dockerResponse.pipe(response);
      }
    });
    upstream.on("error", (error) => {
      console.error(`Docker daemon request failed: ${error.code ?? error.message} (${error.syscall ?? "unknown"} ${error.path ?? ""})`);
      if (!response.headersSent) sendError(response, 502, "Docker daemon socket is unavailable.");
      else response.destroy();
    });
    response.on("close", () => upstream.destroy());
    upstream.end(outgoingBody);
  });
});

const cleanupTimer = setInterval(() => void sweepExpiredContainers(), cleanupIntervalMs);
cleanupTimer.unref();

async function shutdown() {
  clearInterval(cleanupTimer);
  server.close();
  await sweepExpiredContainers();
  for (const id of allowedContainers.keys()) await removeContainer(id, "running");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await sweepExpiredContainers();
server.listen(port, "0.0.0.0", () => {
  console.log(`Policy-limited Docker API proxy listening on ${port}.`);
});
