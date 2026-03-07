import Foundation

/// Handles wallet backup creation and restoration.
/// Backups are encrypted with AES-256-GCM using a user-provided password.
final class BackupService {

    static let shared = BackupService()

    private let crypto = CryptoService.shared
    private let keychain = KeychainService.shared
    private let fileManager = FileManager.default

    enum BackupError: LocalizedError {
        case noWalletsToBackup
        case serializationFailed
        case fileWriteFailed(String)
        case fileReadFailed(String)
        case invalidBackupFormat
        case versionMismatch(Int)
        case decryptionFailed
        case corruptedBackup

        var errorDescription: String? {
            switch self {
            case .noWalletsToBackup:
                return "No wallets to back up"
            case .serializationFailed:
                return "Failed to serialize wallet data"
            case .fileWriteFailed(let path):
                return "Failed to write backup file to \(path)"
            case .fileReadFailed(let path):
                return "Failed to read backup file at \(path)"
            case .invalidBackupFormat:
                return "The selected file is not a valid AgentVault backup"
            case .versionMismatch(let v):
                return "Backup version \(v) is not supported by this app version"
            case .decryptionFailed:
                return "Failed to decrypt backup — incorrect password?"
            case .corruptedBackup:
                return "Backup file appears to be corrupted"
            }
        }
    }

    private init() {}

    // MARK: - Backup Creation

    /// Create an encrypted backup of all provided wallets
    func createBackup(wallets: [Wallet], password: String) throws -> Data {
        guard !wallets.isEmpty else {
            throw BackupError.noWalletsToBackup
        }

        // Collect secrets for each wallet
        var secrets: [[String: String]] = []
        for wallet in wallets {
            var entry: [String: String] = [
                "id": wallet.id.uuidString,
                "chain": wallet.chain.rawValue,
            ]

            if let mnemonic = try? keychain.getMnemonic(forWalletId: wallet.id) {
                entry["mnemonic"] = mnemonic
            }
            if let privateKey = try? keychain.getPrivateKey(forWalletId: wallet.id) {
                entry["privateKey"] = privateKey
            }
            if let jwkData = try? keychain.getJWK(forWalletId: wallet.id) {
                entry["jwk"] = String(data: jwkData, encoding: .utf8)
            }

            secrets.append(entry)
        }

        // Serialize secrets to JSON
        guard let secretsData = try? JSONSerialization.data(withJSONObject: secrets, options: []) else {
            throw BackupError.serializationFailed
        }

        // Encrypt secrets
        let encrypted = try crypto.encrypt(data: secretsData, password: password)

        // Build backup entries
        let entries = wallets.map { wallet in
            WalletBackupEntry(
                id: wallet.id,
                name: wallet.name,
                chain: wallet.chain,
                address: wallet.address,
                createdAt: wallet.createdAt,
                derivationPath: wallet.derivationPath,
                hasMnemonicBackup: wallet.hasMnemonicBackup
            )
        }

        // Create backup structure
        let backup = WalletBackup(
            version: WalletBackup.currentVersion,
            createdAt: Date(),
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0",
            wallets: entries,
            encryptedPayload: encrypted.ciphertext,
            salt: encrypted.salt,
            iv: encrypted.nonce
        )

        // Encode to JSON
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        guard let backupData = try? encoder.encode(backup) else {
            throw BackupError.serializationFailed
        }

        return backupData
    }

    /// Write backup data to a file
    func writeBackup(_ data: Data, to url: URL) throws {
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            throw BackupError.fileWriteFailed(url.path)
        }
    }

    // MARK: - Backup Restoration

    /// Read and validate a backup file, returning the metadata (before decryption)
    func readBackupMetadata(from url: URL) throws -> WalletBackup {
        guard let data = try? Data(contentsOf: url) else {
            throw BackupError.fileReadFailed(url.path)
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        guard let backup = try? decoder.decode(WalletBackup.self, from: data) else {
            throw BackupError.invalidBackupFormat
        }

        guard backup.version <= WalletBackup.currentVersion else {
            throw BackupError.versionMismatch(backup.version)
        }

        return backup
    }

    /// Decrypt and extract wallet secrets from a backup
    func restoreSecrets(from backup: WalletBackup, password: String) throws -> [RestoredWalletSecret] {
        let encrypted = CryptoService.EncryptedData(
            ciphertext: backup.encryptedPayload,
            nonce: backup.iv,
            tag: Data(repeating: 0, count: 16), // Tag is embedded in ciphertext for our format
            salt: backup.salt
        )

        let decryptedData: Data
        do {
            decryptedData = try crypto.decrypt(encrypted: encrypted, password: password)
        } catch {
            throw BackupError.decryptionFailed
        }

        guard let secrets = try? JSONSerialization.jsonObject(with: decryptedData) as? [[String: String]] else {
            throw BackupError.corruptedBackup
        }

        return secrets.compactMap { entry in
            guard let idStr = entry["id"],
                  let id = UUID(uuidString: idStr),
                  let chainStr = entry["chain"],
                  let chain = Chain(rawValue: chainStr) else {
                return nil
            }

            return RestoredWalletSecret(
                walletId: id,
                chain: chain,
                mnemonic: entry["mnemonic"],
                privateKey: entry["privateKey"],
                jwkJSON: entry["jwk"]
            )
        }
    }

    /// Save restored secrets to Keychain
    func saveRestoredSecrets(_ secrets: [RestoredWalletSecret]) throws {
        for secret in secrets {
            if let mnemonic = secret.mnemonic {
                try keychain.saveMnemonic(mnemonic, forWalletId: secret.walletId)
            }
            if let privateKey = secret.privateKey {
                try keychain.savePrivateKey(privateKey, forWalletId: secret.walletId)
            }
            if let jwkJSON = secret.jwkJSON, let jwkData = jwkJSON.data(using: .utf8) {
                try keychain.saveJWK(jwkData, forWalletId: secret.walletId)
            }
        }
    }

    // MARK: - Backup File Management

    /// Default backup directory
    var defaultBackupDirectory: URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let backupDir = appSupport.appendingPathComponent("AgentVaultWallet/Backups", isDirectory: true)
        try? fileManager.createDirectory(at: backupDir, withIntermediateDirectories: true)
        return backupDir
    }

    /// Generate a default backup filename
    func defaultBackupFilename() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HHmmss"
        return "agentvault-backup-\(formatter.string(from: Date())).avbackup"
    }

    /// List existing backup files in the default directory
    func listBackups() -> [BackupFileInfo] {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: defaultBackupDirectory,
            includingPropertiesForKeys: [.creationDateKey, .fileSizeKey],
            options: .skipsHiddenFiles
        ) else { return [] }

        return contents
            .filter { $0.pathExtension == "avbackup" }
            .compactMap { url -> BackupFileInfo? in
                let attrs = try? fileManager.attributesOfItem(atPath: url.path)
                let size = attrs?[.size] as? Int ?? 0
                let created = attrs?[.creationDate] as? Date ?? Date()
                let walletCount = (try? readBackupMetadata(from: url))?.wallets.count

                return BackupFileInfo(
                    url: url,
                    filename: url.lastPathComponent,
                    createdAt: created,
                    fileSize: size,
                    walletCount: walletCount
                )
            }
            .sorted { $0.createdAt > $1.createdAt }
    }
}

/// Secrets extracted from a backup for a single wallet
struct RestoredWalletSecret {
    let walletId: UUID
    let chain: Chain
    let mnemonic: String?
    let privateKey: String?
    let jwkJSON: String?
}

/// Metadata about a backup file on disk
struct BackupFileInfo: Identifiable {
    let id = UUID()
    let url: URL
    let filename: String
    let createdAt: Date
    let fileSize: Int
    let walletCount: Int?

    var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: Int64(fileSize), countStyle: .file)
    }
}
