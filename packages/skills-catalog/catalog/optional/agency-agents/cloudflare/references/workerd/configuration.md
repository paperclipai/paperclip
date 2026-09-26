# Workerd Configuration

## Basic Structure
```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .mainWorker)],
  sockets = [(name = "http", address = "*:8080", http = (), service = "main")]
);

const mainWorker :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "src/index.js")],
  compatibilityDate = "2024-01-15",
  bindings = [...]
);
```

## Services
**Worker**: Run JS/Wasm code
```capnp
(name = "api", worker = (
  modules = [(name = "index.js", esModule = embed "index.js")],
  compatibilityDate = "2024-01-15",
  bindings = [...]
))
```

**Network**: Internet access
```capnp
(name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))
```

**External**: Reverse proxy
```capnp
(name = "backend", external = (address = "api.com:443", http = (style = tls)))
```

**Disk**: Static files
```capnp
(name = "assets", disk = (path = "/var/www", writable = false))
```

## Sockets
```capnp
(name = "http", address = "*:8080", http = (), service = "main")
(name = "https", address = "*:443", https = (options = (), tlsOptions = (keypair = (...))), service = "main")
(name = "app", address = "unix:/tmp/app.sock", http = (), service = "main")
```

## Worker Formats
```capnp
# ES Modules (recommended)
modules = [(name = "index.js", esModule = embed "src/index.js"), (name = "wasm.wasm", wasm = embed "build/module.wasm")]

# Service Worker (legacy)
serviceWorkerScript = embed "worker.js"

# CommonJS
(name = "legacy.js", commonJsModule = embed "legacy.js", namedExports = ["foo"])
```

## Bindings
Bindings expose resources to workers. ES modules: `env.BINDING`, Service workers: globals.

### Primitive Types
```capnp
(name = "API_KEY", text = "secret")                    # String
(name = "CONFIG", json = '{"key":"val"}')              # Parsed JSON
(name = "DATA", data = embed "data.bin")               # ArrayBuffer
(name = "DATABASE_URL", fromEnvironment = "DB_URL")    # System env var
```

### Service Binding
```capnp
(name = "AUTH", service = "auth-worker")               # Basic
(name = "API", service = (
  name = "backend",
  entrypoint = "adminApi",                             # Named export
  props = (json = '{"role":"admin"}')                  # ctx.props
))
```

### Storage
```capnp
(name = "CACHE", kvNamespace = "kv-service")           # KV
(name = "STORAGE", r2Bucket = "r2-service")            # R2
(name = "ROOMS", durableObjectNamespace = (
  serviceName = "room-service",
  className = "Room"
))
(name = "FAST", memoryCache = (
  id = "cache-id",
  limits = (maxKeys = 1000, maxValueSize = 1048576)
))
```

### Other
```capnp
(name = "TASKS", queue = "queue-service")
(name = "ANALYTICS", analyticsEngine = "analytics")
(name = "LOADER", workerLoader = (id = "dynamic"))
(name = "KEY", cryptoKey = (format = raw, algorithm = (name = "HMAC", hash = "SHA-256"), keyData = embed "key.bin", usages = [sign, verify], extractable = false))
(name = "TRACED", wrapped = (moduleName = "tracing", entrypoint = "makeTracer", innerBindings = [(name = "backend", service = "backend")]))
```

## Compatibility
```capnp
compatibilityDate = "2024-01-15"                       # Always set!
compatibilityFlags = ["nodejs_compat", "streams_enable_constructors"]
```

Version = max compat date. Update carefully after testing.

## Parameter Bindings (Inheritance)
```capnp
const base :Workerd.Worker = (
  modules = [...], compatibilityDate = "2024-01-15",
  bindings = [(name = "API_URL", parameter = (type = text)), (name = "DB", parameter = (type = service))]
);

const derived :Workerd.Worker = (
  inherit = "base-service",
  bindings = [(name = "API_URL", text = "https://api.com"), (name = "DB", service = "postgres")]
);
```

## Durable Objects Config
```capnp
const worker :Workerd.Worker = (
  modules = [...],
  compatibilityDate = "2024-01-15",
  bindings = [(name = "ROOMS", durableObjectNamespace = "Room")],
  durableObjectNamespaces = [(className = "Room", uniqueKey = "v1")],
  durableObjectStorage = (localDisk = "/var/do")
);
```

## Remote Bindings (Development)

Connect local workerd to production Cloudflare resources:

```capnp
bindings = [
  # Remote KV (requires API token)
  (name = "PROD_KV", kvNamespace = (
    remote = (
      accountId = "your-account-id",
      namespaceId = "your-namespace-id",
      apiToken = .envVar("CF_API_TOKEN")
    )
  )),
  
  # Remote R2
  (name = "PROD_R2", r2Bucket = (
    remote = (
      accountId = "your-account-id",
      bucketName = "my-bucket",
      apiToken = .envVar("CF_API_TOKEN")
    )
  )),
  
  # Remote Durable Object
  (name = "PROD_DO", durableObjectNamespace = (
    remote = (
      accountId = "your-account-id",
      scriptName = "my-worker",
      className = "MyDO",
      apiToken = .envVar("CF_API_TOKEN")
    )
  ))
]
```

**Note:** Remote bindings require network access and valid Cloudflare API credentials.

## Logging & Debugging
```capnp
logging = (structuredLogging = true, stdoutPrefix = "OUT: ", stderrPrefix = "ERR: ")
v8Flags = ["--expose-gc", "--max-old-space-size=2048"]  # ⚠️ Unsupported in production
```

See [patterns.md](./patterns.md) for multi-service examples, [gotchas.md](./gotchas.md) for config errors.
