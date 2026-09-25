# Safe discovery fetches

Step 2 of this skill reads OAuth metadata out of an MCP server you do not
control and have not authenticated to. Two of the URLs you follow are chosen by
that server:

- `resource_metadata` in the `WWW-Authenticate` challenge (RFC 9728), and
- each entry of `authorization_servers` in the protected-resource document,
  which becomes the issuer you build the RFC 8414 URL from.

Both arrive before any trust is established. A hostile or compromised endpoint
can point either one at `http://169.254.169.254/latest/meta-data/`, at a service
on `127.0.0.1`, at a name it published in public DNS with a loopback `A` record,
or at a host that answers the resolver honestly once and answers again with an
internal address a moment later. A plain `curl` of those values turns the
authoring machine into the attacker's HTTP client, inside whatever network the
author happens to be on.

So the two fetches go through `safe_curl` below instead of bare `curl`. It
validates the destination *before* anything is sent, pins the connection to the
addresses it validated, and follows no redirect.

## The rules

| Input | What happens |
| --- | --- |
| Any scheme other than `https:` | Refused. It is an allowlist, so `http:`, `file:`, `ftp:`, `gopher:` and `data:` all land here without being enumerated. |
| A URL with userinfo (`https://a:b@host/`) | Refused. Credentials never belong on an unauthenticated discovery fetch, and userinfo is the classic way to make a host look like something it is not. |
| Any port other than 443 | Refused. A provider that genuinely publishes discovery on another port is a gap to record and escalate, not a default to widen. |
| A host that resolves to loopback, private, CGNAT, link-local, site-local, unique-local, multicast, benchmarking, documentation or reserved space | Refused, and the reason names the address. This is on resolved addresses, so a public DNS name with a `127.0.0.1` record is caught. |
| An IPv4-mapped (`::ffff:a9fe:a9fe`), NAT64 (`64:ff9b::`) or 6to4 (`2002::`) address wrapping a blocked IPv4 address | Refused. The embedded address is extracted and run through the IPv4 rules. |
| A host with several `A`/`AAAA` records where **one** is blocked | Refused. One bad answer in a round-robin set refuses the whole host. |
| Anything resolvable and allowed | Fetched with `--resolve` pinned to exactly the addresses that were validated, so a second DNS answer cannot move the request after the check. |
| A proxy in the environment (`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, …) | Bypassed with `--noproxy '*'`, and a note is printed. A proxy receives the hostname and resolves it itself, so `--resolve` would be ignored and the validated addresses would not be the ones connected to. |
| A proxy in `~/.curlrc` | Ignored: `-q` is the first option, so curl reads no config file. |
| Any `3xx` response | Refused. The redirect is reported and not followed. To go there you re-run `safe_curl` on the `Location`, which validates it on its own merits. |
| A response over 1 MiB, or 15 seconds | Refused by `--max-filesize` / `--max-time`. |

Refusal is exit code 2 and means **nothing was sent**. The guard resolves names
but never opens a connection to the target.

### What this does not protect against

Say these out loud rather than letting the guard imply more than it does.

- **A publicly routable host that is still internal to you.** Split-horizon DNS
  or a VPN can make a globally-addressable answer reach something private. Run
  discovery from a network position with no privileged internal access; the
  guard cannot see your routing table.
- **An egress path that requires a proxy.** The wrapper refuses to use one, so
  in that environment it fails closed and discovery through this recipe is not
  available. That is the intended outcome: record it as a gap and run discovery
  from somewhere with direct egress. Do not remove `--noproxy` to make it work
  — a proxy resolves the attacker-chosen hostname on its own, which is exactly
  the check being defeated.
- **A lying resolver.** The guard checks what `getaddrinfo` returns. If the
  resolver itself is hostile, it can return an allowed address that fronts an
  internal service.
- **The provider being malicious at the application layer.** Refusing internal
  destinations says nothing about whether the metadata itself is honest. The
  `issuer` cross-check in Step 2 — discard an authorization-server document
  whose `issuer` disagrees with the issuer you built the URL from — is a
  separate control and still required.
- **Anything after discovery.** This covers the two unauthenticated metadata
  fetches. Registration, consent and token exchange run through the product's
  own guarded path, not through this recipe.

## Why it is inlined here

Same reason as `offline-verification.md`: a skill package with anything under
`scripts/` derives the `scripts_executables` trust level
(`deriveTrustLevel` in `packages/skills-catalog/src/catalog-builder.ts`), and
the shipped catalog pins that set to one key. Carrying the guard as
documentation keeps this package `markdown_only` and installable with no
audit-allowlist change. Save both files yourself; the Node file needs no
`chmod`.

## The guard

Save as `mcp-discovery-guard.mjs`. It requires Node 18 or newer and no
dependencies. It prints `ALLOW <host> <port> <addr[,addr...]>` or
`REFUSE <reason>`, exiting 0 or 2.

<details>
<summary><code>mcp-discovery-guard.mjs</code></summary>

```javascript
// Resolve an untrusted discovery URL and decide whether it may be fetched.
// Prints "ALLOW <host> <port> <addr[,addr...]>" or "REFUSE <reason>", and
// exits 0 or 2. It never opens a connection to the target itself.
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const refuse = (why) => {
  process.stdout.write(`REFUSE ${why}\n`);
  process.exit(2);
};

const raw = process.argv[2];
if (!raw) refuse("no URL given");

let url;
try {
  url = new URL(raw);
} catch {
  refuse(`not a URL: ${raw}`);
}
// Scheme allowlist, not a denylist: file:, gopher:, ftp:, data: and plain
// http: all land here.
if (url.protocol !== "https:") refuse(`scheme is not https: ${url.protocol}`);
if (url.username || url.password) refuse("URL carries userinfo");
const port = url.port === "" ? "443" : url.port;
if (port !== "443") refuse(`port is not 443: ${port}`);

const host = url.hostname.replace(/^\[|\]$/g, "");
if (!host) refuse("URL has no host");

const v4Blocks = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved / broadcast"],
];

const v4ToInt = (a) =>
  a.split(".").reduce((acc, oct) => acc * 256 + Number(oct), 0);

const classifyV4 = (addr) => {
  const n = v4ToInt(addr);
  for (const [base, bits, label] of v4Blocks) {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return label;
  }
  return null;
};

// Expand any IPv6 form to 16 bytes.
const v6Bytes = (addr) => {
  let head = addr;
  let tailV4 = null;
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    tailV4 = maybeV4.split(".").map(Number);
    head = addr.slice(0, lastColon + 1) + "0:0";
  }
  const [left, right] = head.split("::");
  const parse = (part) =>
    part && part.length ? part.split(":").map((h) => parseInt(h, 16)) : [];
  const l = parse(left);
  const r = right === undefined ? [] : parse(right);
  const groups =
    right === undefined
      ? l
      : [...l, ...Array(8 - l.length - r.length).fill(0), ...r];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (tailV4) bytes.splice(12, 4, ...tailV4);
  return bytes;
};

const bytesToV4 = (b) => b.join(".");

const classifyV6 = (addr) => {
  const b = v6Bytes(addr);
  if (!b) return "unparseable IPv6 address";
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified address";
  if (zero(0, 15) && b[15] === 1) return "loopback";
  // ::ffff:0:0/96 — IPv4-mapped. Check the embedded address under v4 rules.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    const inner = bytesToV4(b.slice(12));
    return classifyV4(inner) ? `IPv4-mapped ${inner} (${classifyV4(inner)})` : null;
  }
  // 64:ff9b::/96 — NAT64. Same treatment.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    const inner = bytesToV4(b.slice(12));
    return classifyV4(inner) ? `NAT64 ${inner} (${classifyV4(inner)})` : null;
  }
  // 2002::/16 — 6to4. The embedded v4 is bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) {
    const inner = bytesToV4(b.slice(2, 6));
    return classifyV4(inner) ? `6to4 ${inner} (${classifyV4(inner)})` : null;
  }
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return "discard-only";
  // 2001:db8::/32 — documentation. Match b[2] exactly: `b[2] & 0xfe` clears
  // the low bit and so can never equal the odd 0x0d.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return "documentation";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return "IETF protocol assignments";
  if ((b[0] & 0xfe) === 0xfc) return "unique local";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local";
  // fec0::/10 — site-local. Deprecated by RFC 3879 but still carried on some
  // internal networks, so it stays refused.
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "site-local";
  if (b[0] === 0xff) return "multicast";
  return null;
};

const classify = (addr) => (isIP(addr) === 4 ? classifyV4(addr) : classifyV6(addr));

let addresses;
const literal = isIP(host);
if (literal) {
  addresses = [host];
} else {
  try {
    // getaddrinfo, the same resolution curl performs.
    addresses = (await lookup(host, { all: true, verbatim: true })).map(
      (r) => r.address,
    );
  } catch (err) {
    refuse(`DNS lookup failed for ${host}: ${err.code ?? err.message}`);
  }
}
if (!addresses.length) refuse(`no addresses for ${host}`);

// Every address must pass. One bad answer in a round-robin set is enough to
// refuse the whole host.
for (const addr of addresses) {
  const bad = classify(addr);
  if (bad) refuse(`${host} resolves to ${addr} (${bad})`);
}

process.stdout.write(`ALLOW ${host} ${port} ${addresses.join(",")}\n`);
```

</details>

## The fetch wrapper

Save as `safe-fetch.sh` next to the guard and `source` it. It needs curl 7.59
or newer for the comma-separated `--resolve` form.

<details>
<summary><code>safe-fetch.sh</code></summary>

```bash
#!/usr/bin/env bash
# safe_curl <url> [extra curl args...]
#
# Fetch a URL that an unauthenticated remote server chose for you.
#
#   * validates the destination before anything is sent,
#   * pins the connection to the addresses it validated, so a second DNS
#     answer cannot move the request after the check,
#   * refuses to go through a proxy, which would resolve the hostname itself
#     and make the pinning meaningless,
#   * ignores curl's config files, which can set a proxy behind your back,
#   * follows no redirect, ever.
#
# The body goes to stdout. The status line and response headers go to stderr,
# so `safe_curl "$URL" | jq .` and `safe_curl "$URL" 2>&1 | grep -i www-auth`
# both work. Exit 2 means refused and nothing was sent.

# The Node guard that classifies the destination. Defaults to the file next to
# this one; override with MCP_DISCOVERY_GUARD.
MCP_DISCOVERY_GUARD=${MCP_DISCOVERY_GUARD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/mcp-discovery-guard.mjs}

safe_curl() {
  local url=$1; shift
  local verdict host port addrs body headers status rc

  [ -f "$MCP_DISCOVERY_GUARD" ] || {
    printf 'safe_curl: guard not found: %s\n' "$MCP_DISCOVERY_GUARD" >&2; return 2; }

  verdict=$(node "$MCP_DISCOVERY_GUARD" "$url")
  if [ $? -ne 0 ]; then
    printf 'safe_curl: %s\n' "${verdict#REFUSE }" >&2; return 2
  fi
  read -r _ host port addrs <<<"$verdict"

  # A proxy would receive the hostname and resolve it on its own, so the
  # addresses this wrapper validated would not be the ones connected to. The
  # proxy is bypassed rather than trusted. If your egress *requires* one, this
  # recipe fails closed and that is the correct outcome -- record it as a gap.
  for v in HTTPS_PROXY https_proxy ALL_PROXY all_proxy HTTP_PROXY http_proxy; do
    if [ -n "${!v:-}" ]; then
      printf 'safe_curl: %s is set and is being bypassed (--noproxy). A proxy resolves the hostname itself, which would defeat address pinning. If egress requires the proxy this fetch will fail; report that rather than removing the flag.\n' "$v" >&2
      break
    fi
  done

  body=$(mktemp); headers=$(mktemp)
  # -q first: curl reads ~/.curlrc otherwise, and that file can set a proxy.
  status=$(curl -q -sS \
    --proto '=https' --tlsv1.2 \
    --noproxy '*' \
    --resolve "$host:$port:$addrs" \
    --max-redirs 0 --max-time 15 --max-filesize 1048576 \
    -D "$headers" -o "$body" -w '%{http_code}' \
    "$@" "$url")
  rc=$?
  if [ $rc -ne 0 ]; then
    printf 'safe_curl: transport error (curl exit %s) for %s\n' "$rc" "$url" >&2
    rm -f "$body" "$headers"; return 3
  fi

  case $status in
    3??)
      printf 'safe_curl: %s answered %s -> %s\n' "$url" "$status" \
        "$(awk 'tolower($1)=="location:"{print $2}' "$headers" | tr -d '\r')" >&2
      printf 'safe_curl: redirect not followed. Run safe_curl against that URL to validate it on its own merits.\n' >&2
      rm -f "$body" "$headers"; return 2 ;;
  esac

  cat "$headers" >&2
  cat "$body"
  rm -f "$body" "$headers"
  return 0
}
```

</details>

## Executed evidence

Run 2026-09-24 on Linux aarch64, Node v24.20.0, curl 8.5.0.

### Adversarial metadata, end to end

Not a synthetic URL list: a hostile `WWW-Authenticate` challenge and two hostile
protected-resource documents, parsed exactly the way Step 2 tells you to parse
them, then fetched.

```
resource_metadata from challenge: https://localtest.me/.well-known/oauth-protected-resource
safe_curl: localtest.me resolves to ::1 (loopback)
  -> exit 2
issuer from protected-resource doc: http://169.254.169.254/latest/meta-data/
safe_curl: scheme is not https: http:
  -> exit 2
issuer from protected-resource doc: https://[::ffff:169.254.169.254]
safe_curl: ::ffff:a9fe:a9fe resolves to ::ffff:a9fe:a9fe (IPv4-mapped 169.254.169.254 (link-local / cloud metadata))
  -> exit 2
```

`localtest.me` is the case a string check cannot catch: an ordinary-looking
public hostname with a real public DNS record pointing at loopback. Nothing in
the URL text is suspicious. Only resolution reveals it.

### Every refusal class

```
http://wisdom-api.enterpret.com/x                                   REFUSE scheme is not https: http:
file:///etc/passwd                                                  REFUSE scheme is not https: file:
gopher://wisdom-api.enterpret.com/                                  REFUSE scheme is not https: gopher:
https://127.0.0.1/.well-known/oauth-protected-resource              REFUSE 127.0.0.1 resolves to 127.0.0.1 (loopback)
https://localhost/x                                                 REFUSE localhost resolves to 127.0.0.1 (loopback)
https://[::1]/x                                                     REFUSE ::1 resolves to ::1 (loopback)
https://169.254.169.254/latest/meta-data/iam/security-credentials/  REFUSE 169.254.169.254 resolves to 169.254.169.254 (link-local / cloud metadata)
https://[fd00::1]/x                                                 REFUSE fd00::1 resolves to fd00::1 (unique local)
https://[fe80::1]/x                                                 REFUSE fe80::1 resolves to fe80::1 (link-local)
https://10.0.0.5/x                                                  REFUSE 10.0.0.5 resolves to 10.0.0.5 (private)
https://192.168.1.1/x                                               REFUSE 192.168.1.1 resolves to 192.168.1.1 (private)
https://172.16.0.1/x                                                REFUSE 172.16.0.1 resolves to 172.16.0.1 (private)
https://100.64.0.1/x                                                REFUSE 100.64.0.1 resolves to 100.64.0.1 (carrier-grade NAT)
https://[::ffff:127.0.0.1]/x                                        REFUSE ::ffff:7f00:1 resolves to ::ffff:7f00:1 (IPv4-mapped 127.0.0.1 (loopback))
https://[64:ff9b::7f00:1]/x                                         REFUSE 64:ff9b::7f00:1 resolves to 64:ff9b::7f00:1 (NAT64 127.0.0.1 (loopback))
https://[2002:7f00:1::]/x                                           REFUSE 2002:7f00:1:: resolves to 2002:7f00:1:: (6to4 127.0.0.1 (loopback))
https://attacker:pw@wisdom-api.enterpret.com/x                      REFUSE URL carries userinfo
https://wisdom-api.enterpret.com:8443/x                             REFUSE port is not 443: 8443
https://localtest.me/x                                              REFUSE localtest.me resolves to ::1 (loopback)
https://[fec0::1]/x                                                 REFUSE fec0::1 resolves to fec0::1 (site-local)
https://[2001:db8::1]/x                                             REFUSE 2001:db8::1 resolves to 2001:db8::1 (documentation)
https://[::]/x                                                      REFUSE :: resolves to :: (unspecified address)
https://[ff02::1]/x                                                 REFUSE ff02::1 resolves to ff02::1 (multicast)
https://198.18.0.1/x                                                REFUSE 198.18.0.1 resolves to 198.18.0.1 (benchmarking)
https://255.255.255.255/x                                           REFUSE 255.255.255.255 resolves to 255.255.255.255 (reserved / broadcast)
https://2130706433/x                                                REFUSE 127.0.0.1 resolves to 127.0.0.1 (loopback)
https://0x7f.0.0.1/x                                                REFUSE 127.0.0.1 resolves to 127.0.0.1 (loopback)
not-a-url                                                           REFUSE not a URL: not-a-url
```

The last two are worth their own line: `2130706433` and `0x7f.0.0.1` are
`127.0.0.1` written as a decimal integer and with a hex first octet. A string
check for `127.` misses both. The guard never does string checks — it parses
the URL with the WHATWG parser, which normalizes these to `127.0.0.1` before
classification.

The addresses that must **not** be refused, checked in the same pass so the
list above is not just an over-blocking guard: `https://google.com/`,
`https://wisdom-api.enterpret.com/`, `https://8.8.8.8/`,
`https://[2607:f8b0:4009:812::200e]/` and `https://[2600::1]/` all print
`ALLOW`.

### The proxy bypass is load-bearing, not decorative

`--resolve` is ignored the moment curl uses a proxy: the hostname goes to the
proxy in the `CONNECT`, and the proxy resolves it. Same request, same pinned
address, with a dead proxy configured:

```
$ HTTPS_PROXY=http://127.0.0.1:9 curl --resolve "$h:443:$a" ...
curl: (7) Failed to connect to 127.0.0.1 port 9
http=000
$ HTTPS_PROXY=http://127.0.0.1:9 curl --noproxy '*' --resolve "$h:443:$a" ...
http=200
```

`~/.curlrc` is the same hole with no environment variable to notice:

```
$ printf 'proxy = http://127.0.0.1:9\n' > "$CURL_HOME/.curlrc"
$ curl      --resolve "$h:443:$a" ...   curl: (7) Failed to connect to 127.0.0.1 port 9
$ curl -q --noproxy '*' --resolve ...   http=200
```

Through `safe_curl`, with both proxy variables set, the note prints and the
fetch still goes direct and returns `200`.

### Redirects are refused, not followed

```
$ safe_curl "https://google.com/"
safe_curl: https://google.com/ answered 301 -> https://www.google.com/
safe_curl: redirect not followed. Run safe_curl against that URL to validate it on its own merits.
exit=2
```

### The documented flow still works

The same two fetches Step 2 asks for, against a real public provider:

```
$ safe_curl "https://wisdom-api.enterpret.com/server/mcp" -X POST \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
HTTP/2 401
www-authenticate: Bearer realm="mcp", resource_metadata="https://wisdom-api.enterpret.com/server/mcp/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"

$ safe_curl "https://wisdom-api.enterpret.com/server/mcp/.well-known/oauth-protected-resource"
{"resource":"https://wisdom-api.enterpret.com/server/mcp","authorization_servers":["https://oauth.enterpret.com"],"scopes_supported":["email","mcp:read","mcp:write"]}
```

A guard that refused the normal path too would just get switched off. It does
not.
