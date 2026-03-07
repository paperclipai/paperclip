# Security Overview

AgentVault's security model and architecture.

## Security Architecture

### Trust Model

```
┌─────────────────────────────────────────────────────────────┐
│                      User's Machine                          │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │   CLI       │   │   Wallet    │   │   Config    │       │
│  │   AgentVault│   │   Storage   │   │   Files     │       │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘       │
│         │                 │                  │               │
│         └─────────────────┼──────────────────┘               │
│                           │                                  │
│                    ┌──────▼──────┐                          │
│                    │  Local      │                          │
│                    │  Storage    │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTPS/ICP Protocol
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Internet Computer                          │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │   Canister  │   │   VetKeys   │   │   System    │       │
│  │   (Agent)   │   │   Service   │   │   Canisters │       │
│  └─────────────┘   └─────────────┘   └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User Machine | Fully trusted - stores keys and configurations |
| Local Network | Trusted for development, untrusted for production |
| ICP Network | Trusted for canister execution, not for secrets |
| External APIs | Untrusted - validate all inputs |

## Key Security Features

### 1. Encryption

AgentVault uses AES-256-GCM and ChaCha20-Poly1305 for data encryption:

- **Key Derivation**: PBKDF2 with 100,000 iterations
- **IV Generation**: Cryptographically random 12-byte IV
- **Authentication**: Built-in authentication tags
- **Comparison**: Timing-safe HMAC comparison

### 2. Key Management

| Key Type | Storage | Protection |
|----------|---------|------------|
| ICP Identity | `~/.config/dfx/` | dfx managed |
| Wallet Private Keys | `~/.agentvault/wallets/` | CBOR serialized |
| Mnemonics | Not stored after import | Memory only |
| API Keys | Environment variables | User responsibility |

### 3. Authentication

- **ICP Identity**: Ed25519 key pairs managed by dfx
- **Canister Controllers**: Principal-based access control
- **Anonymous Access**: Local development only

### 4. Network Security

- **HTTPS**: All mainnet communication over HTTPS
- **ICP Protocol**: Native ICP protocol for canister calls
- **Certificate Validation**: Full certificate chain validation

## Known Limitations (v1.0)

| Feature | Status | Mitigation |
|---------|--------|------------|
| Wallet Crypto | Basic SHA-256 | Use hardware wallets for production |
| VetKeys | Simulated | Use ICP VetKeys canister for production |
| Bittensor | Requires API | Validate API responses |
| Arweave | Requires wallet | Verify transaction confirmations |

## Security Best Practices

### For Users

1. **Never share mnemonics or private keys**
2. **Use environment variables for secrets**
3. **Enable HTTPS for all production deployments**
4. **Regularly backup wallets and configurations**
5. **Review canister controllers before deployment**

### For Developers

1. **Validate all external inputs**
2. **Use timing-safe comparisons for secrets**
3. **Clear sensitive data from memory after use**
4. **Never log secrets or PII**
5. **Use parameterized queries and commands**

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public issue
2. Email security concerns to the maintainers
3. Include steps to reproduce
4. Allow time for response before disclosure

## Security Audit

See [Security Audit Report](../dev/SECURITY_AUDIT.md) for v1.0 findings and recommendations.
