import Foundation

/// Represents a single wallet managed by the application
struct Wallet: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    let chain: Chain
    let address: String
    let createdAt: Date
    var lastAccessedAt: Date

    /// Whether this wallet was imported (vs. created fresh)
    let isImported: Bool

    /// Optional balance cached from last refresh
    var cachedBalance: String?
    var balanceLastUpdated: Date?

    /// Derivation path used (empty for Arweave JWK)
    let derivationPath: String

    /// Whether the mnemonic is stored in Keychain
    let hasMnemonicBackup: Bool

    init(
        id: UUID = UUID(),
        name: String,
        chain: Chain,
        address: String,
        isImported: Bool = false,
        derivationPath: String = "",
        hasMnemonicBackup: Bool = false
    ) {
        self.id = id
        self.name = name
        self.chain = chain
        self.address = address
        self.createdAt = Date()
        self.lastAccessedAt = Date()
        self.isImported = isImported
        self.derivationPath = derivationPath
        self.hasMnemonicBackup = hasMnemonicBackup
    }

    /// Truncated address for display
    var shortAddress: String {
        if address.count > 20 {
            let prefix = String(address.prefix(10))
            let suffix = String(address.suffix(8))
            return "\(prefix)...\(suffix)"
        }
        return address
    }

    /// Explorer URL for this wallet's address
    var explorerURL: URL? {
        guard let base = chain.explorerURLBase else { return nil }
        return URL(string: base + address)
    }

    /// Formatted balance string with symbol
    var displayBalance: String {
        guard let balance = cachedBalance else { return "—" }
        return "\(balance) \(chain.symbol)"
    }
}

/// Represents the result of a wallet generation or import
struct WalletCreationResult {
    let wallet: Wallet
    let mnemonic: String?      // 12/24-word phrase (nil for JWK imports)
    let privateKeyHex: String? // Hex-encoded private key
    let jwkData: Data?         // Arweave JWK JSON (only for Arweave)
}

/// Wallet metadata stored in the backup manifest
struct WalletBackupEntry: Codable, Identifiable {
    let id: UUID
    let name: String
    let chain: Chain
    let address: String
    let createdAt: Date
    let derivationPath: String
    let hasMnemonicBackup: Bool
}

/// Full backup file structure
struct WalletBackup: Codable {
    let version: Int
    let createdAt: Date
    let appVersion: String
    let wallets: [WalletBackupEntry]
    let encryptedPayload: Data // AES-256-GCM encrypted wallet secrets
    let salt: Data             // PBKDF2 salt
    let iv: Data               // AES IV/nonce

    static let currentVersion = 1
}
