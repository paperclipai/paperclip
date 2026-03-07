# Wallet Guide

This guide covers wallet management, transactions, and cycles in AgentVault.

## Overview

AgentVault supports multi-chain wallets:
- **ICP (Internet Computer)** - Primary wallet for canister operations
- **Polkadot** - For cross-chain transactions
- **Solana** - For DeFi and DApp interactions

## Wallet Types

### Local Wallet

Encrypted wallet stored locally on disk:

```bash
# Create local wallet
agentvault wallet create

# Features:
# - Encrypted storage (AES-256)
# - Hardware wallet compatibility
# - Multiple accounts support
```

### Hardware Wallet

Connect hardware wallet (Ledger, etc.):

```bash
# Connect hardware wallet
agentvault wallet connect --hardware

# Features:
# - Private key never leaves device
# - Transaction signing on device
# - Firmware updates required
```

## Creating Wallets

### ICP Wallet

```bash
# Create new ICP wallet
agentvault wallet create --network icp

# Output: Wallet ID and principal
```

### Importing Wallet

Import existing wallet from mnemonic or private key:

```bash
# Import from mnemonic
agentvault wallet import --mnemonic

# Import from private key
agentvault wallet import --private-key
```

## Wallet Commands

### List Wallets

View all connected wallets:

```bash
agentvault wallet list
```

### Wallet Balance

Check wallet balance:

```bash
# Check all wallets
agentvault wallet balance

# Check specific wallet
agentvault wallet balance <wallet-id>
```

### Sign Transaction

Sign a transaction with wallet:

```bash
# Sign transaction
agentvault wallet sign <wallet-id> --transaction <tx-payload>

# Options:
# --hardware     - Use hardware wallet
# --broadcast   - Broadcast after signing
```

### Transaction History

View transaction history:

```bash
# View all transactions
agentvault wallet history

# View wallet-specific
agentvault wallet history <wallet-id>

# Filter by type
agentvault wallet history --type send
agentvault wallet history --type receive
```

### Export Wallet

Export wallet keys for backup:

```bash
# Export to JSON
agentvault wallet export <wallet-id> --format json

# Export to mnemonic (use with caution)
agentvault wallet export <wallet-id> --format mnemonic --show
```

## Cycles Management

### Top-up Cycles

Add cycles to wallet:

```bash
# Top-up canister
agentvault wallet top-up <canister-id> --amount 1000000000000

# Options:
# --network icp      - Target network
# --auto-refill     - Enable auto-refill
```

### Transfer Cycles

Transfer cycles between wallets:

```bash
# Transfer cycles
agentvault wallet transfer --from <wallet-id> --to <wallet-id> --amount 1000000000000
```

### Multi-send

Send cycles to multiple recipients:

```bash
# Batch transfer
agentvault wallet multi-send --input transfers.json

# Input format:
# {
#   "transfers": [
#     { "to": "recipient-1", "amount": 1000000000000 },
#     { "to": "recipient-2", "amount": 5000000000000 }
#   ]
# }
```

### Process Queue

View and process pending transaction queue:

```bash
# View queue
agentvault wallet queue

# Process queue
agentvault wallet queue --process

# Clear failed transactions
agentvault wallet queue --clear-failed
```

## Cross-Chain Operations

### Polkadot

```bash
# Create Polkadot wallet
agentvault wallet create --chain polkadot

# Check balance
agentvault wallet balance <wallet-id> --chain polkadot

# Transfer tokens
agentvault wallet transfer --chain polkadot --to <address> --amount 1000
```

### Solana

```bash
# Create Solana wallet
agentvault wallet create --chain solana

# Check balance
agentvault wallet balance <wallet-id> --chain solana

# Transfer SOL
agentvault wallet transfer --chain solana --to <address> --amount 1.5
```

## Security Best Practices

### Key Management

- [ ] **Never share mnemonics** - Store securely, never transmit
- [ ] **Use hardware wallets** - For large holdings
- [ ] **Regular backups** - Export wallet to secure location
- [ ] **Verify addresses** - Double-check before sending
- [ ] **Use test transactions** - Small amounts first

### Transaction Safety

- [ ] **Verify recipient address** - Copy-paste carefully
- [ ] **Confirm amounts** - Large transactions, double-check
- [ ] **Review transaction details** - Before broadcasting
- [ ] **Monitor confirmations** - Check on-chain status
- [ ] **Keep records** - Save transaction IDs for reference

### Recovery

**Lost mnemonic?**
```bash
# Can only recover with mnemonic
agentvault wallet restore --mnemonic "word1 word2 word3 ..."

# No way to recover without mnemonic
```

**Lost private key?**
```bash
# Cannot recover
# Generate new wallet with remaining funds
```

## Troubleshooting

### Wallet Not Found

```bash
# List all wallets
agentvault wallet list

# Verify wallet ID
agentvault wallet info <wallet-id>
```

### Insufficient Balance

```bash
# Check balance
agentvault wallet balance

# Request from faucet (testnet only)
agentvault wallet faucet

# Purchase cycles
agentvault wallet purchase --amount 1000000000000
```

### Transaction Failed

```bash
# Check transaction queue
agentvault wallet queue

# Retry failed transaction
agentwallet wallet retry <tx-id>

# View error details
agentvault wallet history <tx-id> --details
```

### Hardware Wallet Issues

```bash
# Reconnect hardware wallet
agentvault wallet reconnect --hardware

# Check firmware
agentvault wallet check --hardware

# Reset connection
agentvault wallet disconnect --hardware
```

## Advanced Features

### Multi-Signature Wallets

Configure multi-sig for enhanced security:

```bash
# Create multi-sig wallet
agentvault wallet create --multisig --signers 3 --threshold 2

# Sign transaction
agentvault wallet sign <wallet-id> --multisig --signers-required 2
```

### Derivation Paths

Standard derivation paths for BIP-39/44:

```bash
# View derivation path
agentvault wallet info <wallet-id> --show-derivation

# Change derivation path
agentvault wallet set-derivation <wallet-id> --path "m/44'/223'/0'/0"
```

### Custom Networks

Add custom blockchain networks:

```bash
# Add network
agentvault network add --name custom --rpc https://custom-rpc.com

# Use network
agentvault deploy --network custom
```

## Integration

### ICP Canister Funding

```bash
# Top-up canister from wallet
agentvault wallet top-up <canister-id> --wallet <wallet-id>

# Auto-refill configuration
agentvault wallet configure <wallet-id> --auto-refill --threshold 100T
```

### DApp Integration

Connect wallet to Web3 DApps:

```bash
# Inject wallet into browser
agentvault wallet inject --browser chrome

# Use with DApp
agentvault wallet dapp-sign <url>
```

## Next Steps

- [ ] Read [Deployment Guide](./deployment.md) for canister funding
- [ ] Read [Troubleshooting](./troubleshooting.md) for common issues
- [ ] Explore [Security Documentation](../security/overview.md)
