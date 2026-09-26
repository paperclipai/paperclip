# Workerd Gotchas

## Common Errors

### "Missing compatibility date"
**Cause:** Compatibility date not set
**Solution:**
❌ Wrong:
```capnp
const worker :Workerd.Worker = (
  serviceWorkerScript = embed "worker.js"
)
```

✅ Correct:
```capnp
const worker :Workerd.Worker = (
  serviceWorkerScript = embed "worker.js",
  compatibilityDate = "2024-01-15"  # Always set!
)
```

### Wrong Binding Type
**Problem:** JSON not parsed
**Cause:** Using `text = '{"key":"value"}'` instead of `json`
**Solution:** Use `json = '{"key":"value"}'` for parsed objects

### Service vs Namespace
**Problem:** Cannot create DO instance
**Cause:** Using `service = "room-service"` for Durable Object
**Solution:** Use `durableObjectNamespace = "Room"` for DO bindings

### Module Name Mismatch
**Problem:** Import fails
**Cause:** Module name includes path: `name = "src/index.js"`
**Solution:** Use simple names: `name = "index.js"`, embed with path

## Network Access

**Problem:** Fetch fails with network error
**Cause:** No network service configured (workerd has no global fetch)
**Solution:** Add network service binding:
```capnp
services = [(name = "internet", network = (allow = ["public"]))]
bindings = [(name = "NET", service = "internet")]
```

Or external service:
```capnp
bindings = [(name = "API", service = (external = (address = "api.com:443", http = (style = tls))))]
```

### "Worker not responding"
**Cause:** Socket misconfigured, no fetch handler, or port unavailable
**Solution:** Verify socket `address` matches, worker exports `fetch()`, port available

### "Binding not found"
**Cause:** Name mismatch or service doesn't exist
**Solution:** Check binding name in config matches code (`env.BINDING` for ES modules)

### "Module not found"
**Cause:** Module name doesn't match import or bad embed path
**Solution:** Module `name` must match import path exactly, verify `embed` path

### "Compatibility error"
**Cause:** Date not set or API unavailable on that date
**Solution:** Set `compatibilityDate`, verify API available on that date

## Performance Issues

**Problem:** High memory usage
**Cause:** Large caches or many isolates
**Solution:** Set cache limits, reduce isolate count, or use V8 flags (caution)

**Problem:** Slow startup
**Cause:** Many modules or complex config
**Solution:** Compile to binary (`workerd compile`), reduce imports

**Problem:** Request timeouts
**Cause:** External service issues or DNS problems
**Solution:** Check connectivity, DNS resolution, TLS handshake

## Build Issues

**Problem:** Cap'n Proto syntax errors
**Cause:** Invalid config or missing schema
**Solution:** Install capnproto tools, validate: `capnp compile -I. config.capnp`

**Problem:** Embed path not found
**Cause:** Path relative to config file
**Solution:** Use correct relative path or absolute path

**Problem:** V8 flags cause crashes
**Cause:** Unsafe V8 flags
**Solution:** ⚠️ V8 flags unsupported in production. Test thoroughly before use.

## Security Issues

**Problem:** Hardcoded secrets in config
**Cause:** `text` binding with secret value
**Solution:** Use `fromEnvironment` to load from env vars

**Problem:** Overly broad network access
**Cause:** `network = (allow = ["*"])`
**Solution:** Restrict to `allow = ["public"]` or specific hosts

**Problem:** Extractable crypto keys
**Cause:** `cryptoKey = (extractable = true, ...)`
**Solution:** Set `extractable = false` unless export required

## Compatibility Changes

**Problem:** Breaking changes after compat date update
**Cause:** New flags enabled between dates
**Solution:** Review [compat dates docs](https://developers.cloudflare.com/workers/configuration/compatibility-dates/), test locally first

**Problem:** "Compatibility date not supported"
**Cause:** Workerd version older than compat date
**Solution:** Update workerd binary (version = max compat date supported)

## Limits

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| V8 flags | Unsupported in production | Use with caution |
| Compatibility date | Must match workerd version | Update if mismatch |
| Module count | Affects startup time | Many imports slow |

## Troubleshooting Steps

1. **Enable verbose logging**: `workerd serve config.capnp --verbose`
2. **Check logs**: Look for error messages, stack traces
3. **Validate config**: `capnp compile -I. config.capnp`
4. **Test bindings**: Log `Object.keys(env)` to verify
5. **Check versions**: Workerd version vs compat date
6. **Isolate issue**: Minimal repro config
7. **Review schema**: [workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)

See [configuration.md](./configuration.md) for config details, [patterns.md](./patterns.md) for working examples, [api.md](./api.md) for runtime APIs.
