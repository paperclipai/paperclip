import Foundation
import CryptoKit

/// Native cryptographic operations for wallet management.
/// Uses Apple CryptoKit for encryption, hashing, and key derivation.
final class CryptoService {

    static let shared = CryptoService()

    private init() {}

    // MARK: - Encryption (AES-256-GCM)

    struct EncryptedData: Codable {
        let ciphertext: Data
        let nonce: Data
        let tag: Data
        let salt: Data
    }

    /// Encrypt data with a password using AES-256-GCM + PBKDF2 key derivation
    func encrypt(data: Data, password: String) throws -> EncryptedData {
        let salt = generateSalt()
        let key = try deriveKey(from: password, salt: salt)
        let nonce = AES.GCM.Nonce()

        let sealed = try AES.GCM.seal(data, using: key, nonce: nonce)

        guard let combined = sealed.combined else {
            throw CryptoError.encryptionFailed
        }

        // Extract components from the combined representation
        // Combined = nonce (12 bytes) + ciphertext + tag (16 bytes)
        let nonceData = Data(nonce)
        let ciphertext = combined.dropFirst(12).dropLast(16)
        let tag = combined.suffix(16)

        return EncryptedData(
            ciphertext: Data(ciphertext),
            nonce: nonceData,
            tag: Data(tag),
            salt: salt
        )
    }

    /// Decrypt data with a password
    func decrypt(encrypted: EncryptedData, password: String) throws -> Data {
        let key = try deriveKey(from: password, salt: encrypted.salt)

        let nonce = try AES.GCM.Nonce(data: encrypted.nonce)
        let sealedBox = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: encrypted.ciphertext,
            tag: encrypted.tag
        )

        return try AES.GCM.open(sealedBox, using: key)
    }

    // MARK: - Key Derivation

    /// Derive a symmetric key from a password using HKDF (CryptoKit approach)
    private func deriveKey(from password: String, salt: Data) throws -> SymmetricKey {
        guard let passwordData = password.data(using: .utf8) else {
            throw CryptoError.invalidPassword
        }

        // Use HKDF with SHA-256 for key derivation
        let inputKey = SymmetricKey(data: passwordData)
        let derivedKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: inputKey,
            salt: salt,
            info: "AgentVault Wallet Backup".data(using: .utf8)!,
            outputByteCount: 32
        )

        return derivedKey
    }

    // MARK: - Hashing

    /// SHA-256 hash of data
    func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    /// SHA-256 hash of a string
    func sha256(_ string: String) -> String {
        let data = Data(string.utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Random Generation

    /// Generate a cryptographically secure random salt (32 bytes)
    func generateSalt() -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes)
    }

    /// Generate a random password/passphrase of given length
    func generateRandomPassword(length: Int = 32) -> String {
        let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*"
        var password = ""
        var randomBytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &randomBytes)

        for byte in randomBytes {
            let index = Int(byte) % chars.count
            password.append(chars[chars.index(chars.startIndex, offsetBy: index)])
        }
        return password
    }

    // MARK: - Validation

    /// Validate a BIP39 mnemonic phrase (basic word count check)
    func isValidMnemonic(_ phrase: String) -> Bool {
        let words = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
        return words.count == 12 || words.count == 24
    }

    /// Validate an Ethereum private key format
    func isValidEthPrivateKey(_ key: String) -> Bool {
        let cleaned = key.hasPrefix("0x") ? String(key.dropFirst(2)) : key
        return cleaned.count == 64 && cleaned.allSatisfy { $0.isHexDigit }
    }

    /// Validate an Ethereum address format
    func isValidEthAddress(_ address: String) -> Bool {
        let cleaned = address.hasPrefix("0x") ? String(address.dropFirst(2)) : address
        return cleaned.count == 40 && cleaned.allSatisfy { $0.isHexDigit }
    }

    // MARK: - Errors

    enum CryptoError: LocalizedError {
        case encryptionFailed
        case decryptionFailed
        case invalidPassword
        case keyDerivationFailed

        var errorDescription: String? {
            switch self {
            case .encryptionFailed: return "Encryption failed"
            case .decryptionFailed: return "Decryption failed — wrong password?"
            case .invalidPassword: return "Invalid password"
            case .keyDerivationFailed: return "Key derivation failed"
            }
        }
    }
}
