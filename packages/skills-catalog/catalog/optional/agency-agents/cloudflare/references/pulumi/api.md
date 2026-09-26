# API & Data Sources

## Outputs and Exports

Export resource identifiers:

```typescript
export const kvId = kv.id;
export const bucketName = bucket.name;
export const workerUrl = worker.subdomain;
export const dbId = db.id;
```

## Resource Dependencies

Implicit dependencies via outputs:

```typescript
const kv = new cloudflare.WorkersKvNamespace("kv", {
    accountId: accountId,
    title: "my-kv",
});

// Worker depends on KV (implicit via kv.id)
const worker = new cloudflare.WorkerScript("worker", {
    accountId: accountId,
    name: "my-worker",
    content: code,
    kvNamespaceBindings: [{name: "MY_KV", namespaceId: kv.id}], // Creates dependency
});
```

Explicit dependencies:

```typescript
const migration = new command.local.Command("migration", {
    create: pulumi.interpolate`wrangler d1 execute ${db.name} --file ./schema.sql`,
}, {dependsOn: [db]});

const worker = new cloudflare.WorkerScript("worker", {
    accountId: accountId,
    name: "worker",
    content: code,
    d1DatabaseBindings: [{name: "DB", databaseId: db.id}],
}, {dependsOn: [migration]}); // Ensure migrations run first
```

## Using Outputs with API Calls

```typescript
const db = new cloudflare.D1Database("db", {accountId, name: "my-db"});

db.id.apply(async (dbId) => {
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
        {method: "POST", headers: {"Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json"},
         body: JSON.stringify({sql: "CREATE TABLE users (id INT)"})}
    );
    return response.json();
});
```

## Custom Dynamic Providers

For resources not in provider:

```typescript
import * as pulumi from "@pulumi/pulumi";

class D1MigrationProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs: any): Promise<pulumi.dynamic.CreateResult> {
        const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${inputs.accountId}/d1/database/${inputs.databaseId}/query`,
            {method: "POST", headers: {"Authorization": `Bearer ${inputs.apiToken}`, "Content-Type": "application/json"},
             body: JSON.stringify({sql: inputs.sql})}
        );
        return {id: `${inputs.databaseId}-${Date.now()}`, outs: await response.json()};
    }
    async update(id: string, olds: any, news: any): Promise<pulumi.dynamic.UpdateResult> {
        if (olds.sql !== news.sql) await this.create(news);
        return {};
    }
    async delete(id: string, props: any): Promise<void> {}
}

class D1Migration extends pulumi.dynamic.Resource {
    constructor(name: string, args: any, opts?: pulumi.CustomResourceOptions) {
        super(new D1MigrationProvider(), name, args, opts);
    }
}

const migration = new D1Migration("migration", {
    accountId, databaseId: db.id, apiToken, sql: "CREATE TABLE users (id INT)",
}, {dependsOn: [db]});
```

## Data Sources

**Get Zone:**
```typescript
const zone = cloudflare.getZone({name: "example.com"});
const zoneId = zone.then(z => z.id);
```

**Get Accounts (via API):**
Use Cloudflare API directly or custom dynamic resources.

## Import Existing Resources

```bash
# Import worker
pulumi import cloudflare:index/workerScript:WorkerScript my-worker <account_id>/<worker_name>

# Import KV namespace
pulumi import cloudflare:index/workersKvNamespace:WorkersKvNamespace my-kv <namespace_id>

# Import R2 bucket
pulumi import cloudflare:index/r2Bucket:R2Bucket my-bucket <account_id>/<bucket_name>

# Import D1 database
pulumi import cloudflare:index/d1Database:D1Database my-db <account_id>/<database_id>

# Import DNS record
pulumi import cloudflare:index/dnsRecord:DnsRecord my-record <zone_id>/<record_id>
```

## Secrets Management

```typescript
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const apiKey = config.requireSecret("apiKey"); // Encrypted in state

const worker = new cloudflare.WorkerScript("worker", {
    accountId: accountId,
    name: "my-worker",
    content: code,
    secretTextBindings: [{name: "API_KEY", text: apiKey}],
});
```

Store secrets:
```bash
pulumi config set --secret apiKey "secret-value"
```

## Transform Pattern

Modify resource args before creation:

```typescript
import {Transform} from "@pulumi/pulumi";

interface BucketArgs {
    accountId: pulumi.Input<string>;
    transform?: {bucket?: Transform<cloudflare.R2BucketArgs>};
}

function createBucket(name: string, args: BucketArgs) {
    const bucketArgs: cloudflare.R2BucketArgs = {
        accountId: args.accountId,
        name: name,
        location: "auto",
    };
    const finalArgs = args.transform?.bucket?.(bucketArgs) ?? bucketArgs;
    return new cloudflare.R2Bucket(name, finalArgs);
}
```

## v6.x Worker Versioning Resources

**Worker** - Container for versions:
```typescript
const worker = new cloudflare.Worker("api", {accountId, name: "api-worker"});
export const workerId = worker.id;
```

**WorkerVersion** - Immutable code + config:
```typescript
const version = new cloudflare.WorkerVersion("v1", {
    accountId, workerId: worker.id,
    content: fs.readFileSync("./dist/worker.js", "utf8"),
    compatibilityDate: "2025-01-01",
});
export const versionId = version.id;
```

**WorkersDeployment** - Active deployment with bindings:
```typescript
const deployment = new cloudflare.WorkersDeployment("prod", {
    accountId, workerId: worker.id, versionId: version.id,
    kvNamespaceBindings: [{name: "MY_KV", namespaceId: kv.id}],
});
```

**Use:** Advanced deployments (canary, blue-green). Most apps should use `WorkerScript` (auto-versioning).

---
See: [README.md](./README.md), [configuration.md](./configuration.md), [patterns.md](./patterns.md), [gotchas.md](./gotchas.md)
