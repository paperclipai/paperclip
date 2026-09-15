import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  INERT_BODY,
  INVALID_SIGNATURE,
  TIMEOUT_MS,
  isPublicAddress,
  main,
  parseArgs,
  probeTarget,
} from "./chat-webhook-ingress.mjs";

const script = fileURLToPath(
  new URL("./chat-webhook-ingress.mjs", import.meta.url),
);
const webhookPath = "/api/chat-webhooks/fixture-public-id-secret/slack";
const publicUrl = `https://canary.example.com:8443${webhookPath}`;
const secret = "PRIVATE_RESPONSE_CREDENTIAL_CANARY";
const runFile = promisify(execFile);

async function fixture(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}${webhookPath}`;
  const target = parseArgs(["--url", publicUrl, "--compare-url", url])
    .targets[1];
  return { server, target, url };
}

function assertRedacted(value) {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  for (const denied of [
    secret,
    "fixture-public-id-secret",
    "canary.example.com",
    "/api/chat-webhooks",
    "127.0.0.1",
    "http:",
    "https:",
  ]) {
    assert.equal(
      output.includes(denied),
      false,
      `unexpected private output: ${denied}`,
    );
  }
}

test("no URL, help, invalid options and missing values never invoke networking", async () => {
  for (const argv of [
    [],
    ["--help"],
    ["--url"],
    ["--compare-url", publicUrl],
    ["--relay-ip", "8.8.8.8"],
    ["--url", publicUrl, "--url", publicUrl],
    [publicUrl],
    ["--help", "--url", publicUrl],
    ["--url", publicUrl, "--headers", secret],
    ["--url", publicUrl, "--retry", "1"],
    ["--url", publicUrl, "--timeout", "999"],
    ["--url", publicUrl, "--"],
    ["--url", 123],
  ]) {
    let calls = 0;
    let output = "";
    const status = await main(argv, {
      write: (line) => {
        output += line;
      },
      probe: () => {
        calls++;
      },
    });
    assert.equal(calls, 0);
    assert.equal(status, argv.length === 0 || argv.join() === "--help" ? 0 : 2);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("fixture-public-id-secret"), false);
  }
});

for (const raw of [
  `http://canary.example.com${webhookPath}`,
  `https://user:password@canary.example.com${webhookPath}`,
  `${publicUrl}?token=${secret}`,
  `${publicUrl}#${secret}`,
  `${publicUrl}?`,
  `${publicUrl}#`,
  `${publicUrl}\r\nAuthorization: ${secret}`,
  `${publicUrl}\t`,
  ` ${publicUrl}`,
  `https://canary.example.com/%2e%2e${webhookPath}`,
  `https://canary.example.com/wrong/..${webhookPath}`,
  `https://canary.example.com\\evil${webhookPath}`,
  `https://canary.example.com${webhookPath.replace("/slack", "/telegram")}`,
  `https://canary.example.com${webhookPath}/`,
  `https://127.0.0.1${webhookPath}`,
  `https://[::1]${webhookPath}`,
  `https://canary.local${webhookPath}`,
  `https://canary.internal${webhookPath}`,
  `https://canary.example.com:0${webhookPath}`,
  `https://canary.example.com:999999${webhookPath}`,
]) {
  test(`rejects unsafe public URL variant ${[...raw].reduce((sum, char) => sum + char.codePointAt(0), 0)}`, async () => {
    let output = "";
    assert.equal(
      await main(["--url", raw], {
        write: (line) => {
          output += line;
        },
        probe: () => assert.fail("networking"),
      }),
      2,
    );
    assertRedacted(output);
  });
}

test("comparator is exact literal loopback HTTP with exactly the same path", () => {
  for (const authority of ["127.0.0.1:3104", "[::1]:3104"]) {
    assert.equal(
      parseArgs([
        "--url",
        publicUrl,
        "--compare-url",
        `http://${authority}${webhookPath}`,
      ]).targets.length,
      2,
    );
  }
  for (const value of [
    `https://127.0.0.1${webhookPath}`,
    `http://localhost${webhookPath}`,
    `http://127.1${webhookPath}`,
    `http://2130706433${webhookPath}`,
    `http://127.0.0.2${webhookPath}`,
    `http://10.0.0.1${webhookPath}`,
    `http://127.0.0.1:3104${webhookPath.replace("fixture-public", "another-public")}`,
    `http://127.0.0.1:3104${webhookPath}\r\nCookie: ${secret}`,
  ])
    assert.throws(() =>
      parseArgs(["--url", publicUrl, "--compare-url", value]),
    );
});

test("only unambiguous public relay IPs are accepted, including no IPv6 tunneling", () => {
  for (const address of [
    "8.8.8.8",
    "209.177.145.192",
    "2607:f740:f::b31",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(isPublicAddress(address), true);
    assert.equal(
      parseArgs(["--url", publicUrl, "--relay-ip", address]).targets[0].relayIp,
      address,
    );
  }
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
    "4000::1",
    "fe80::1%en0",
    "[2607:f740:f::b31]",
    "8.8.8.8:443",
    "008.008.008.008",
    "0x08080808",
    "134744072",
    "example.com",
    "8.8.8.8\r\nAuthorization: secret",
    " 8.8.8.8",
    "8.8.8.8 ",
    "",
  ]) {
    assert.equal(isPublicAddress(address), false);
    assert.throws(() => parseArgs(["--url", publicUrl, "--relay-ip", address]));
  }
});

test("401 is one inert POST, with no copied auth or response content", async (t) => {
  let calls = 0;
  let headers;
  let method;
  let path;
  let body = "";
  const { target } = await fixture(t, (req, res) => {
    calls++;
    headers = req.headers;
    method = req.method;
    path = req.url;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () =>
      res
        .writeHead(401, { "Set-Cookie": secret, "X-Request-Id": secret })
        .end(secret),
    );
  });
  const result = await probeTarget(target);
  assert.equal(calls, 1);
  assert.equal(method, "POST");
  assert.equal(path, webhookPath);
  assert.equal(body, INERT_BODY);
  assert.equal(headers.host, "canary.example.com:8443");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["x-slack-signature"], INVALID_SIGNATURE);
  assert.equal(/^v0=[a-f0-9]{64}$/u.test(headers["x-slack-signature"]), false);
  assert.ok(
    Math.abs(
      Number(headers["x-slack-request-timestamp"]) * 1_000 - Date.now(),
    ) < 2_000,
  );
  assert.equal(result.outcome, "expected_rejection");
  assert.equal(result.status, 401);
  assert.equal(result.errorCode, null);
  assert.equal(result.timingsMs.dns, null);
  assert.equal(result.timingsMs.tls, null);
  assert.ok(result.timingsMs.connect <= result.timingsMs.ttfb);
  assert.ok(result.timingsMs.ttfb <= result.timingsMs.total);
  assertRedacted(result);
});

for (const status of [
  101, 200, 202, 204, 301, 302, 307, 308, 400, 403, 404, 429, 500, 502,
]) {
  test(`HTTP ${status} is unexpected; no redirect, retry or body wait`, async (t) => {
    let destinationCalls = 0;
    let calls = 0;
    const destination = await fixture(t, (_req, res) => {
      destinationCalls++;
      res.end();
    });
    const { target } = await fixture(t, (_req, res) => {
      calls++;
      res.writeHead(status, {
        Location: `${destination.url}?token=${secret}`,
        "Set-Cookie": secret,
      });
      res.flushHeaders(); // Deliberately never end a body: the probe must discard it.
    });
    const result = await probeTarget(target, { timeoutMs: 1_000 });
    assert.equal(result.status, status);
    assert.equal(result.outcome, "unexpected_status");
    assert.equal(calls, 1);
    assert.equal(destinationCalls, 0);
    assertRedacted(result);
    let output = "";
    assert.equal(
      await main(["--url", publicUrl], {
        write: (line) => {
          output += line;
        },
        probe: async () => result,
      }),
      1,
    );
    assertRedacted(output);
  });
}

test("hard deadline destroys a real held HTTP connection instead of retrying", async (t) => {
  let calls = 0;
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const { target } = await fixture(t, (req) => {
    calls++;
    req.socket.once("close", close);
  });
  const result = await probeTarget(target, { timeoutMs: 200 });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.errorCode, "DEADLINE_EXCEEDED");
  assert.equal(result.status, null);
  assert.equal(result.timingsMs.ttfb, null);
  await closed;
  assert.equal(calls, 1);
  assert.equal(TIMEOUT_MS, 8_000);
  await assert.rejects(probeTarget(target, { timeoutMs: 8_001 }));
  assertRedacted(result);
});

test("default eight-second deadline cancels original DNS and forbids late request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release4;
  let release6;
  let cancelled = 0;
  let requests = 0;
  const target = parseArgs(["--url", publicUrl]).targets[0];
  const promise = probeTarget(target, {
    createResolver: () => ({
      resolve4: () =>
        new Promise((resolve) => {
          release4 = resolve;
        }),
      resolve6: () =>
        new Promise((resolve) => {
          release6 = resolve;
        }),
      cancel: () => {
        cancelled++;
        release4(["8.8.8.8"]);
        release6([]);
      },
    }),
    request: () => {
      requests++;
      assert.fail("late request");
    },
  });
  t.mock.timers.tick(7_999);
  assert.equal(cancelled, 0);
  t.mock.timers.tick(1);
  const result = await promise;
  await Promise.resolve();
  assert.equal(result.outcome, "timeout");
  assert.equal(cancelled, 1);
  assert.equal(requests, 0);
});

test("deadline also destroys an actual socket held during TLS handshake", async (t) => {
  let close;
  let connections = 0;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("data", () => {}); // Consume the ClientHello, but never answer it.
    socket.once("close", () => {
      sockets.delete(socket);
      close();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const target = parseArgs(["--url", publicUrl, "--relay-ip", "8.8.8.8"])
    .targets[0];
  const result = await probeTarget(target, {
    timeoutMs: 200,
    // Test-only transport routes the real TLS client to this owned TCP fixture.
    // It does not disable TLS verification or expose a CLI private-relay option.
    request: (options, callback) =>
      https.request(
        {
          ...options,
          port: server.address().port,
          lookup: (_hostname, _options, callback) =>
            callback(null, "127.0.0.1", 4),
        },
        callback,
      ),
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.status, null);
  assert.notEqual(result.timingsMs.connect, null);
  assert.equal(result.timingsMs.tls, null);
  await closed;
  assert.equal(connections, 1);
  assertRedacted(result);
});

test("DNS private or mixed answers fail closed before any connection", async () => {
  for (const addresses of [
    ["100.64.0.1"],
    ["8.8.8.8", "127.0.0.1"],
    ["::ffff:127.0.0.1"],
  ]) {
    const result = await probeTarget(
      parseArgs(["--url", publicUrl]).targets[0],
      {
        createResolver: () => ({
          resolve4: async () => addresses,
          resolve6: async () => [],
          cancel() {},
        }),
        request: () => assert.fail("private network connection"),
      },
    );
    assert.equal(result.outcome, "unsafe_resolution");
    assert.equal(result.errorCode, "NON_PUBLIC_DNS_ANSWER");
    assertRedacted(result);
  }
});

test("public resolution/override pins one address but preserves Host, TLS SNI and verification", async () => {
  for (const override of [null, "2607:f740:f::b31"]) {
    const argv = [
      "--url",
      publicUrl,
      ...(override ? ["--relay-ip", override] : []),
    ];
    let requests = 0;
    let dnsCalls = 0;
    let destroyed = 0;
    const result = await probeTarget(parseArgs(argv).targets[0], {
      createResolver: () => ({
        resolve4: async () => {
          dnsCalls++;
          return ["8.8.8.8", "8.8.4.4"];
        },
        resolve6: async () => {
          dnsCalls++;
          return [];
        },
        cancel() {},
      }),
      request: (options, callback) => {
        requests++;
        assert.equal(options.hostname, "canary.example.com");
        assert.equal(options.servername, "canary.example.com");
        assert.equal(options.headers.Host, "canary.example.com:8443");
        assert.equal(options.path, webhookPath);
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.auth, undefined);
        assert.equal(options.autoSelectFamily, false);
        assert.ok(options.agent instanceof https.Agent);
        assert.deepEqual(options.agent.options.proxyEnv, {});
        options.lookup(options.hostname, {}, (error, address) => {
          assert.equal(error, null);
          assert.equal(address, override ?? "8.8.8.8");
        });
        const req = new EventEmitter();
        req.destroy = () => {
          destroyed++;
        };
        req.end = (body) => {
          assert.equal(body, "{}");
          const socket = new EventEmitter();
          req.emit("socket", socket);
          socket.emit("connect");
          socket.emit("secureConnect");
          const response = new EventEmitter();
          response.statusCode = 401;
          response.on("newListener", (event) => assert.notEqual(event, "data"));
          response.read = () => assert.fail("response body must never be read");
          response.destroy = () => {};
          callback(response);
        };
        return req;
      },
    });
    assert.equal(requests, 1);
    assert.equal(dnsCalls, override ? 0 : 2);
    assert.equal(destroyed, 1);
    assert.equal(result.outcome, "expected_rejection");
    assert.ok(result.timingsMs.connect <= result.timingsMs.tls);
    assert.ok(result.timingsMs.tls <= result.timingsMs.ttfb);
    assertRedacted(result);
  }
});

test("failed pinned family is not retried with another DNS answer; asynchronous errors are redacted", async () => {
  let calls = 0;
  let destroys = 0;
  let cancelled = 0;
  const result = await probeTarget(parseArgs(["--url", publicUrl]).targets[0], {
    createResolver: () => ({
      resolve4: async () => ["8.8.8.8", "8.8.4.4"],
      resolve6: async () => ["2001:4860:4860::8888"],
      cancel: () => {
        cancelled++;
      },
    }),
    request: (options) => {
      calls++;
      options.lookup(options.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
      });
      const request = new EventEmitter();
      request.destroy = () => {
        destroys++;
      };
      request.end = () =>
        queueMicrotask(() =>
          request.emit(
            "error",
            Object.assign(new Error(`${publicUrl} ${secret}`), {
              code: "ENETUNREACH",
            }),
          ),
        );
      return request;
    },
  });
  assert.equal(result.outcome, "network_error");
  assert.equal(result.errorCode, "ENETUNREACH");
  assert.equal(calls, 1);
  assert.equal(destroys, 1);
  assert.equal(cancelled, 1);
  assertRedacted(result);
});

test("network/DNS exceptions expose only closed error codes, never messages or stdout/stderr", async () => {
  for (const code of ["ECONNRESET", "ENOTFOUND", secret, undefined]) {
    const error = Object.assign(new Error(`${publicUrl} ${secret}`), {
      code,
      stdout: secret,
      stderr: secret,
    });
    const target = parseArgs(["--url", publicUrl, "--relay-ip", "8.8.8.8"])
      .targets[0];
    const result = await probeTarget(target, {
      request: () => {
        throw error;
      },
    });
    assert.equal(result.outcome, "network_error");
    assert.equal(
      result.errorCode,
      ["ECONNRESET", "ENOTFOUND"].includes(code) ? code : "NETWORK_ERROR",
    );
    assertRedacted(result);
    const dnsResult = await probeTarget(
      parseArgs(["--url", publicUrl]).targets[0],
      {
        createResolver: () => ({
          resolve4: async () => {
            throw error;
          },
          resolve6: async () => {
            throw error;
          },
          cancel() {},
        }),
        request: () => assert.fail("failed DNS must not connect"),
      },
    );
    assert.equal(dnsResult.outcome, "network_error");
    assertRedacted(dnsResult);
    let output = "";
    assert.equal(
      await main(["--url", publicUrl], {
        write: (line) => {
          output += line;
        },
        probe: async () => {
          throw error;
        },
      }),
      1,
    );
    assertRedacted(output);
  }
});

test("actual socket failure is redacted and not retried", async (t) => {
  let calls = 0;
  const { target } = await fixture(t, (req) => {
    calls++;
    req.socket.destroy();
  });
  const result = await probeTarget(target);
  assert.equal(result.outcome, "network_error");
  assert.equal(result.errorCode, "ECONNRESET");
  assert.equal(calls, 1);
  assertRedacted(result);
});

test("CLI child and real comparator ignore proxy/auth environments and redact bad argv", async (t) => {
  let proxyCalls = 0;
  const proxy = await fixture(t, (_req, res) => {
    proxyCalls++;
    res.end(secret);
  });
  const proxyUrl = proxy.url
    .replace(webhookPath, "")
    .replace("http://", `http://user:${secret}@`);
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    PAPERCLIP_AUTH_HEADER: `Bearer ${secret}`,
    PAPERCLIP_COOKIE: secret,
    SLACK_BOT_TOKEN: secret,
  };
  for (const argv of [
    [],
    ["--help"],
    ["--url", `${publicUrl}\r\nCookie: ${secret}`],
  ]) {
    let child;
    try {
      child = await runFile(process.execPath, [script, ...argv], {
        env,
        timeout: 5_000,
      });
    } catch (error) {
      assert.equal(error.code, 2);
      child = error;
    }
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.includes(secret), false);
    assert.equal(child.stdout.includes("fixture-public-id-secret"), false);
  }
  // Explicitly poison Node's GLOBAL agent as --use-env-proxy does. The canary's
  // fresh agent must still connect straight to the one local fixture.
  const originalAgent = http.globalAgent;
  http.globalAgent = new http.Agent({ proxyEnv: env });
  t.after(() => {
    http.globalAgent.destroy();
    http.globalAgent = originalAgent;
  });
  const direct = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(401).end();
  });
  assert.equal(
    (await probeTarget(direct.target)).outcome,
    "expected_rejection",
  );
  assert.equal(proxyCalls, 0);
});

test("CLI refuses native debug output before starting a request", async () => {
  for (const debug of [
    { NODE_DEBUG: "http,net,tls" },
    { NODE_DEBUG_NATIVE: "TLS" },
    { NODE_OPTIONS: "--trace-tls" },
  ]) {
    const env = {
      ...process.env,
      NODE_DEBUG: "",
      NODE_DEBUG_NATIVE: "",
      NODE_OPTIONS: "",
      ...debug,
    };
    const child = await runFile(
      process.execPath,
      [script, "--url", publicUrl, "--relay-ip", "8.8.8.8"],
      { env, timeout: 5_000 },
    ).catch((error) => error);
    assert.equal(child.code, 2);
    assert.equal(
      JSON.parse(child.stdout).errorCode,
      "UNSAFE_DEBUG_ENVIRONMENT",
    );
    assertRedacted(child.stdout);
    assertRedacted(child.stderr);
  }
});

for (const flag of ["--trace_tls", "--trace-tls=true", "--trace_tls=true"]) {
  for (const source of ["argv", "environment"]) {
    test(`refuses ${source} TLS tracing alias ${flag} without networking`, async (t) => {
      const previousArgv = process.execArgv;
      const previousOptions = process.env.NODE_OPTIONS;
      t.after(() => {
        process.execArgv = previousArgv;
        if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousOptions;
      });
      if (source === "argv") process.execArgv = [...previousArgv, flag];
      else process.env.NODE_OPTIONS = flag;
      let calls = 0;
      let output = "";
      const status = await main(["--url", publicUrl], {
        write: (line) => {
          output += line;
        },
        probe: async () => {
          calls++;
          return { outcome: "expected_rejection" };
        },
      });
      assert.equal(calls, 0);
      assert.equal(status, 2);
      assert.equal(JSON.parse(output).errorCode, "UNSAFE_DEBUG_ENVIRONMENT");
      assertRedacted(output);
    });
  }
}

test("two explicit targets run once in order and any unexpected result fails the command", async () => {
  for (const statuses of [
    [401, 401],
    [502, 401],
    [401, 202],
  ]) {
    const calls = [];
    let output = "";
    const exit = await main(
      [
        "--url",
        publicUrl,
        "--compare-url",
        `http://127.0.0.1:3104${webhookPath}`,
      ],
      {
        write: (line) => {
          output += line;
        },
        probe: async (target) => {
          const status = statuses[calls.length];
          calls.push(target.label);
          return {
            target: target.label,
            status,
            outcome:
              status === 401 ? "expected_rejection" : "unexpected_status",
          };
        },
      },
    );
    assert.deepEqual(calls, ["public", "comparison"]);
    assert.equal(exit, statuses.every((status) => status === 401) ? 0 : 1);
    assert.equal(output.trim().split("\n").length, 2);
    assertRedacted(output);
  }
});
