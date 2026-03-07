# Module Reference

Detailed documentation for AgentVault modules.

## src/deployment/

ICP deployment and canister management.

### icpClient.ts

Primary ICP client for canister operations.

```typescript
import { ICPClient } from 'agentvault';

const client = new ICPClient({
  network: 'local',
  identity: myIdentity
});

await client.createCanister();
await client.installCode(wasm, canisterId);
```

**Key Functions:**
| Function | Description |
|----------|-------------|
| `createCanister()` | Create new canister |
| `installCode()` | Install WASM code |
| `canisterStatus()` | Get canister status |
| `startCanister()` | Start stopped canister |
| `stopCanister()` | Stop running canister |

### deployer.ts

Deployment orchestration.

```typescript
import { deployAgent } from 'agentvault';

const result = await deployAgent({
  projectPath: './my-agent',
  network: 'ic',
  cycles: 1000000000000n
});
```

### promotion.ts

Environment promotion.

```typescript
import { promoteCanister } from 'agentvault';

await promoteCanister({
  from: 'staging',
  to: 'production',
  canisterId: 'abcde-aaaab'
});
```

---

## src/packaging/

WASM compilation and packaging.

### compiler.ts

TypeScript to WASM compilation.

```typescript
import { compileToWasm } from 'agentvault';

const wasm = await compileToWasm({
  entryPoint: './src/index.ts',
  outputPath: './dist/agent.wasm'
});
```

### packager.ts

Package creation.

```typescript
import { createPackage } from 'agentvault';

const pkg = await createPackage({
  projectPath: './my-agent',
  outputDir: './dist'
});
```

---

## src/canister/

Canister bindings and state management.

### actor.ts

Actor creation and management.

```typescript
import { createActor, createAnonymousAgent } from 'agentvault';

const agent = createAnonymousAgent('http://localhost:4943');
const actor = createActor(canisterId, agent);
```

### state.ts

State query and fetch.

```typescript
import { fetchCanisterState, queryState } from 'agentvault';

const state = await fetchCanisterState(canisterId, actor);
const query = await queryState(canisterId, 'getValue');
```

### encryption.ts

AES-256-GCM and ChaCha20-Poly1305 encryption.

```typescript
import { encrypt, decrypt, deriveKey } from 'agentvault';

const key = deriveKey(password, salt);
const encrypted = encrypt(plaintext, key);
const decrypted = decrypt(encrypted, key);
```

---

## src/wallet/

Multi-chain wallet management.

### index.ts

Wallet manager entry point.

```typescript
import { WalletManager } from 'agentvault';

const manager = new WalletManager();
const wallet = await manager.createWallet('ethereum');
```

### providers/

Chain-specific providers:

| Provider | Chain | Features |
|----------|-------|----------|
| `icp-provider.ts` | ICP | Identity, cycles, tokens |
| `ethereum-provider.ts` | Ethereum | EOA, transactions |
| `cketh-provider.ts` | ckETH | ckETH, Etherscan |
| `solana-provider.ts` | Solana | SPL tokens |
| `polkadot-provider.ts` | Polkadot | DOT, staking |

### wallet-storage.ts

Persistent wallet storage.

```typescript
import { saveWallet, loadWallet, listWallets } from 'agentvault';

await saveWallet(wallet);
const loaded = await loadWallet(walletId);
const all = await listWallets(agentId);
```

---

## src/security/

Security primitives and VetKeys.

### vetkeys.ts

Threshold key derivation.

```typescript
import { VetKeysClient, deriveThresholdKey } from 'agentvault';

const client = new VetKeysClient(actor);
const key = await deriveThresholdKey(seedPhrase, 3, 2);
```

### multisig.ts

Multi-signature approvals.

```typescript
import { MultisigManager } from 'agentvault';

const multisig = new MultisigManager();
await multisig.createRequest('deploy', params);
await multisig.signRequest(requestId, signer);
```

---

## src/monitoring/

Health checks and metrics.

### health.ts

Health check implementation.

```typescript
import { runHealthCheck } from 'agentvault';

const result = await runHealthCheck(canisterId, {
  checks: ['status', 'cycles', 'memory']
});
```

### metrics.ts

Metrics collection.

```typescript
import { collectMetrics, getMetricsFilePath } from 'agentvault';

const metrics = await collectMetrics(canisterId);
// Returns: requests, errors, latency, memory, cycles
```

---

## src/backup/

Backup and restore.

### backup.ts

Backup creation.

```typescript
import { createBackup, restoreBackup } from 'agentvault';

const backup = await createBackup(agentName, {
  canisterId: 'abcde-aaaab',
  includeState: true
});

await restoreBackup(backup.id, targetCanisterId);
```

---

## src/archival/

Arweave archival storage.

### arweave-client.ts

Arweave integration.

```typescript
import { ArweaveClient } from 'agentvault';

const client = new ArweaveClient();
await client.upload(backup);
const tx = await client.getStatus(transactionId);
```

---

## src/inference/

AI inference integration.

### bittensor-client.ts

Bittensor network client.

```typescript
import { BittensorClient } from 'agentvault';

const client = new BittensorClient();
const response = await client.query({ prompt: 'Hello' });
```

---

## cli/commands/

CLI command implementations.

### Structure

Each command file exports a Commander.js command:

```typescript
// cli/commands/example.ts
import { Command } from 'commander';

export const exampleCommand = new Command('example')
  .description('Example command')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => {
    // Command implementation
  });
```

### Available Commands

| File | Command | Description |
|------|---------|-------------|
| `init.ts` | `init` | Initialize project |
| `package.ts` | `package` | Package agent |
| `deploy.ts` | `deploy` | Deploy to canister |
| `exec.ts` | `exec` | Execute task |
| `show.ts` | `show` | Show state |
| `fetch.ts` | `fetch` | Download state |
| `status.ts` | `status` | Project status |
| `list.ts` | `list` | List agents |
| `wallet.ts` | `wallet` | Wallet operations |
| `backup.ts` | `backup` | Backup operations |
| `promote.ts` | `promote` | Promote environment |
| `rollback.ts` | `rollback` | Rollback deployment |
| `monitor.ts` | `monitor` | Monitor health |
| `health.ts` | `health` | Health checks |
| `info.ts` | `info` | Canister info |
| `stats.ts` | `stats` | Statistics |
| `logs.ts` | `logs` | View logs |
| `cycles.ts` | `cycles` | Cycles management |
| `tokens.ts` | `tokens` | Token balances |
| `identity.ts` | `identity` | ICP identity |
| `inference.ts` | `inference` | AI inference |
| `archive.ts` | `archive` | Arweave archival |
| `approve.ts` | `approve` | Multisig approvals |
| `profile.ts` | `profile` | Performance profiling |
| `trace.ts` | `trace` | Execution traces |
| `rebuild.ts` | `rebuild` | Rebuild from state |
