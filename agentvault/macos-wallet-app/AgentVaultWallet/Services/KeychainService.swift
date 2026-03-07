import Foundation
import Security

/// Manages secure storage of wallet secrets in the macOS Keychain.
/// Private keys and mnemonics are stored here, never on disk in plaintext.
final class KeychainService {

    static let shared = KeychainService()

    private let servicePrefix = "com.agentvault.wallet"

    enum KeychainError: LocalizedError {
        case saveFailed(OSStatus)
        case readFailed(OSStatus)
        case deleteFailed(OSStatus)
        case dataConversionFailed
        case itemNotFound

        var errorDescription: String? {
            switch self {
            case .saveFailed(let status):
                return "Keychain save failed (status: \(status))"
            case .readFailed(let status):
                return "Keychain read failed (status: \(status))"
            case .deleteFailed(let status):
                return "Keychain delete failed (status: \(status))"
            case .dataConversionFailed:
                return "Failed to convert data for Keychain storage"
            case .itemNotFound:
                return "Item not found in Keychain"
            }
        }
    }

    private init() {}

    // MARK: - Mnemonic Storage

    /// Save a mnemonic phrase for a wallet
    func saveMnemonic(_ mnemonic: String, forWalletId id: UUID) throws {
        let key = mnemonicKey(for: id)
        try saveString(mnemonic, forKey: key)
    }

    /// Retrieve a mnemonic phrase for a wallet
    func getMnemonic(forWalletId id: UUID) throws -> String {
        let key = mnemonicKey(for: id)
        return try getString(forKey: key)
    }

    /// Delete a stored mnemonic
    func deleteMnemonic(forWalletId id: UUID) throws {
        let key = mnemonicKey(for: id)
        try deleteItem(forKey: key)
    }

    /// Check if a mnemonic exists for a wallet
    func hasMnemonic(forWalletId id: UUID) -> Bool {
        let key = mnemonicKey(for: id)
        return (try? getString(forKey: key)) != nil
    }

    // MARK: - Private Key Storage

    /// Save a private key for a wallet
    func savePrivateKey(_ key: String, forWalletId id: UUID) throws {
        let storageKey = privateKeyKey(for: id)
        try saveString(key, forKey: storageKey)
    }

    /// Retrieve a private key for a wallet
    func getPrivateKey(forWalletId id: UUID) throws -> String {
        let key = privateKeyKey(for: id)
        return try getString(forKey: key)
    }

    /// Delete a stored private key
    func deletePrivateKey(forWalletId id: UUID) throws {
        let key = privateKeyKey(for: id)
        try deleteItem(forKey: key)
    }

    // MARK: - JWK Storage (Arweave)

    /// Save JWK data for an Arweave wallet
    func saveJWK(_ jwkData: Data, forWalletId id: UUID) throws {
        let key = jwkKey(for: id)
        try saveData(jwkData, forKey: key)
    }

    /// Retrieve JWK data for an Arweave wallet
    func getJWK(forWalletId id: UUID) throws -> Data {
        let key = jwkKey(for: id)
        return try getData(forKey: key)
    }

    /// Delete stored JWK data
    func deleteJWK(forWalletId id: UUID) throws {
        let key = jwkKey(for: id)
        try deleteItem(forKey: key)
    }

    // MARK: - Backup Password

    /// Save the backup encryption password hint (NOT the actual password)
    func saveBackupPasswordHint(_ hint: String) throws {
        try saveString(hint, forKey: "\(servicePrefix).backup-hint")
    }

    func getBackupPasswordHint() -> String? {
        try? getString(forKey: "\(servicePrefix).backup-hint")
    }

    // MARK: - Bulk Operations

    /// Delete all secrets for a wallet
    func deleteAllSecrets(forWalletId id: UUID) {
        try? deleteMnemonic(forWalletId: id)
        try? deletePrivateKey(forWalletId: id)
        try? deleteJWK(forWalletId: id)
    }

    /// Delete everything from our Keychain namespace
    func purgeAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Private Helpers

    private func mnemonicKey(for id: UUID) -> String {
        "\(servicePrefix).mnemonic.\(id.uuidString)"
    }

    private func privateKeyKey(for id: UUID) -> String {
        "\(servicePrefix).privatekey.\(id.uuidString)"
    }

    private func jwkKey(for id: UUID) -> String {
        "\(servicePrefix).jwk.\(id.uuidString)"
    }

    private func saveString(_ value: String, forKey key: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.dataConversionFailed
        }
        try saveData(data, forKey: key)
    }

    private func getString(forKey key: String) throws -> String {
        let data = try getData(forKey: key)
        guard let string = String(data: data, encoding: .utf8) else {
            throw KeychainError.dataConversionFailed
        }
        return string
    }

    private func saveData(_ data: Data, forKey key: String) throws {
        // Delete existing item first
        try? deleteItem(forKey: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrLabel as String: "AgentVault Wallet Secret",
            kSecAttrDescription as String: "Encrypted wallet key material",
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    private func getData(forKey key: String) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess else {
            if status == errSecItemNotFound {
                throw KeychainError.itemNotFound
            }
            throw KeychainError.readFailed(status)
        }

        guard let data = result as? Data else {
            throw KeychainError.dataConversionFailed
        }

        return data
    }

    private func deleteItem(forKey key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix,
            kSecAttrAccount as String: key,
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }
}
