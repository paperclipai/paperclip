# Architecture Patterns

## Component Resources

```typescript
class WorkerApp extends pulumi.ComponentResource {
    constructor(name: string, args: WorkerAppArgs, opts?) {
        super("custom:cloudflare:WorkerApp", name, {}, opts);
        const defaultOpts = {parent: this};

        this.kv = new cloudflare.WorkersKvNamespace(`${name}-kv`, {accountId: args.accountId, title: `${name}-kv`}, defaultOpts);
        this.worker = new cloudflare.WorkerScript(`${name}-worker`, {
            accountId: args.accountId, name: `${name}-worker`, content: args.workerCode,
            module: true, kvNamespaceBindings: [{name: "KV", namespaceId: this.kv.id}],
        }, defaultOpts);
        this.domain = new cloudflare.WorkersDomain(`${name}-domain`, {
            accountId: args.accountId, hostname: args.domain, service: this.worker.name,
        }, defaultOpts);
    }
}
```

## Full-Stack Worker App

```typescript
const kv = new cloudflare.WorkersKvNamespace("cache", {accountId, title: "api-cache"});
const db = new cloudflare.D1Database("db", {accountId, name: "app-database"});
const bucket = new cloudflare.R2Bucket("assets", {accountId, name: "app-assets"});

const apiWorker = new cloudflare.WorkerScript("api", {
    accountId, name: "api-worker", content: fs.readFileSync("./dist/api.js", "utf8"),
    module: true, kvNamespaceBindings: [{name: "CACHE", namespaceId: kv.id}],
    d1DatabaseBindings: [{name: "DB", databaseId: db.id}],
    r2BucketBindings: [{name: "ASSETS", bucketName: bucket.name}],
});
```

## Multi-Environment Setup

```typescript
const stack = pulumi.getStack();
const worker = new cloudflare.WorkerScript(`worker-${stack}`, {
    accountId, name: `my-worker-${stack}`, content: code,
    plainTextBindings: [{name: "ENVIRONMENT", text: stack}],
});
```

## Queue-Based Processing

```typescript
const queue = new cloudflare.Queue("processing-queue", {accountId, name: "image-processing"});

// Producer: API receives requests
const apiWorker = new cloudflare.WorkerScript("api", {
    accountId, name: "api-worker", content: apiCode,
    queueBindings: [{name: "PROCESSING_QUEUE", queue: queue.id}],
});

// Consumer: Process async
const processorWorker = new cloudflare.WorkerScript("processor", {
    accountId, name: "processor-worker", content: processorCode,
    queueConsumers: [{queue: queue.name, maxBatchSize: 10, maxRetries: 3, maxWaitTimeMs: 5000}],
    r2BucketBindings: [{name: "OUTPUT_BUCKET", bucketName: outputBucket.name}],
});
```

## Microservices with Service Bindings

```typescript
const authWorker = new cloudflare.WorkerScript("auth", {accountId, name: "auth-service", content: authCode});
const apiWorker = new cloudflare.WorkerScript("api", {
    accountId, name: "api-service", content: apiCode,
    serviceBindings: [{name: "AUTH", service: authWorker.name}],
});
```

## Event-Driven Architecture

```typescript
const eventQueue = new cloudflare.Queue("events", {accountId, name: "event-bus"});
const producer = new cloudflare.WorkerScript("producer", {
    accountId, name: "api-producer", content: producerCode,
    queueBindings: [{name: "EVENTS", queue: eventQueue.id}],
});
const consumer = new cloudflare.WorkerScript("consumer", {
    accountId, name: "email-consumer", content: consumerCode,
    queueConsumers: [{queue: eventQueue.name, maxBatchSize: 10}],
});
```

## v6.x Versioned Deployments (Blue-Green/Canary)

```typescript
const worker = new cloudflare.Worker("api", {accountId, name: "api-worker"});
const v1 = new cloudflare.WorkerVersion("v1", {accountId, workerId: worker.id, content: fs.readFileSync("./dist/v1.js", "utf8"), compatibilityDate: "2025-01-01"});
const v2 = new cloudflare.WorkerVersion("v2", {accountId, workerId: worker.id, content: fs.readFileSync("./dist/v2.js", "utf8"), compatibilityDate: "2025-01-01"});

// Gradual rollout: 10% v2, 90% v1
const deployment = new cloudflare.WorkersDeployment("canary", {
    accountId, workerId: worker.id,
    versions: [{versionId: v2.id, percentage: 10}, {versionId: v1.id, percentage: 90}],
    kvNamespaceBindings: [{name: "MY_KV", namespaceId: kv.id}],
});
```

**Use:** Canary releases, A/B testing, blue-green. Most apps use `WorkerScript` (auto-versioning).

## Wrangler.toml Generation (Bridge IaC with Local Dev)

Generate wrangler.toml from Pulumi config to keep local dev in sync:

```typescript
import * as command from "@pulumi/command";

const workerConfig = {
    name: "my-worker",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
};

// Create resources
const kv = new cloudflare.WorkersKvNamespace("kv", {accountId, title: "my-kv"});
const db = new cloudflare.D1Database("db", {accountId, name: "my-db"});
const bucket = new cloudflare.R2Bucket("bucket", {accountId, name: "my-bucket"});

// Generate wrangler.toml after resources created
const wranglerGen = new command.local.Command("gen-wrangler", {
    create: pulumi.interpolate`cat > wrangler.toml <<EOF
name = "${workerConfig.name}"
main = "src/index.ts"
compatibility_date = "${workerConfig.compatibilityDate}"
compatibility_flags = ${JSON.stringify(workerConfig.compatibilityFlags)}

[[kv_namespaces]]
binding = "MY_KV"
id = "${kv.id}"

[[d1_databases]]
binding = "DB"
database_id = "${db.id}"
database_name = "${db.name}"

[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "${bucket.name}"
EOF`,
}, {dependsOn: [kv, db, bucket]});

// Deploy worker after wrangler.toml generated
const worker = new cloudflare.WorkerScript("worker", {
    accountId, name: workerConfig.name, content: code,
    compatibilityDate: workerConfig.compatibilityDate,
    compatibilityFlags: workerConfig.compatibilityFlags,
    kvNamespaceBindings: [{name: "MY_KV", namespaceId: kv.id}],
    d1DatabaseBindings: [{name: "DB", databaseId: db.id}],
    r2BucketBindings: [{name: "MY_BUCKET", bucketName: bucket.name}],
}, {dependsOn: [wranglerGen]});
```

**Benefits:**
- `wrangler dev` uses same bindings as production
- No config drift between Pulumi and local dev
- Single source of truth (Pulumi config)

**Alternative:** Read wrangler.toml in Pulumi (reverse direction) if wrangler is source of truth

## Build + Deploy Pattern

```typescript
import * as command from "@pulumi/command";
const build = new command.local.Command("build", {create: "npm run build", dir: "./worker"});
const worker = new cloudflare.WorkerScript("worker", {
    accountId, name: "my-worker",
    content: build.stdout.apply(() => fs.readFileSync("./worker/dist/index.js", "utf8")),
}, {dependsOn: [build]});
```

## Content SHA Pattern (Force Updates)

Prevent false "no changes" detections:

```typescript
const version = Date.now().toString();
const worker = new cloudflare.WorkerScript("worker", {
    accountId, name: "my-worker", content: code,
    plainTextBindings: [{name: "VERSION", text: version}], // Forces deployment
});
```

---
See: [README.md](./README.md), [configuration.md](./configuration.md), [api.md](./api.md), [gotchas.md](./gotchas.md)
