import Foundation

/// Manages persistent storage of wallet metadata on the filesystem.
/// Secrets are NOT stored here — they live in Keychain only.
final class FileService {

    static let shared = FileService()

    private let fileManager = FileManager.default

    private init() {}

    // MARK: - App Support Directory

    /// The application's data directory
    var appDataDirectory: URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let appDir = appSupport.appendingPathComponent("AgentVaultWallet", isDirectory: true)
        try? fileManager.createDirectory(at: appDir, withIntermediateDirectories: true)
        return appDir
    }

    /// Path to the wallet metadata file
    private var walletsFilePath: URL {
        appDataDirectory.appendingPathComponent("wallets.json")
    }

    // MARK: - Wallet Metadata Persistence

    /// Save wallet list to disk (metadata only, no secrets)
    func saveWallets(_ wallets: [Wallet]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted]
        let data = try encoder.encode(wallets)
        try data.write(to: walletsFilePath, options: [.atomic])
    }

    /// Load wallet list from disk
    func loadWallets() throws -> [Wallet] {
        guard fileManager.fileExists(atPath: walletsFilePath.path) else {
            return []
        }

        let data = try Data(contentsOf: walletsFilePath)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([Wallet].self, from: data)
    }

    /// Delete a specific wallet's metadata from the stored list
    func deleteWallet(withId id: UUID) throws {
        var wallets = try loadWallets()
        wallets.removeAll { $0.id == id }
        try saveWallets(wallets)
    }

    // MARK: - File Dialogs

    /// Suggest a save location for backup files
    var suggestedBackupURL: URL {
        let desktop = fileManager.urls(for: .desktopDirectory, in: .userDomainMask).first!
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let filename = "AgentVault-Backup-\(formatter.string(from: Date())).avbackup"
        return desktop.appendingPathComponent(filename)
    }

    // MARK: - Import File Validation

    /// Read and validate a JWK file
    func readJWKFile(at url: URL) throws -> Data {
        let data = try Data(contentsOf: url)

        // Basic validation: should be valid JSON with "n" and "d" fields (RSA key)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["n"] != nil,
              json["kty"] as? String == "RSA" else {
            throw FileError.invalidJWKFile
        }

        return data
    }

    /// Read and validate a PEM file
    func readPEMFile(at url: URL) throws -> String {
        let content = try String(contentsOf: url, encoding: .utf8)
        guard content.contains("BEGIN") && content.contains("KEY") else {
            throw FileError.invalidPEMFile
        }
        return content
    }

    /// Read and validate an Ethereum keystore JSON file
    func readKeystoreFile(at url: URL) throws -> Data {
        let data = try Data(contentsOf: url)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["crypto"] != nil || json["Crypto"] != nil else {
            throw FileError.invalidKeystoreFile
        }
        return data
    }

    enum FileError: LocalizedError {
        case invalidJWKFile
        case invalidPEMFile
        case invalidKeystoreFile

        var errorDescription: String? {
            switch self {
            case .invalidJWKFile:
                return "The selected file is not a valid Arweave JWK wallet file"
            case .invalidPEMFile:
                return "The selected file is not a valid PEM identity file"
            case .invalidKeystoreFile:
                return "The selected file is not a valid Ethereum keystore file"
            }
        }
    }
}
