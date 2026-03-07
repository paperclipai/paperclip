import SwiftUI

/// Supported blockchain networks
enum Chain: String, CaseIterable, Identifiable, Codable {
    case icp = "ICP"
    case ethereum = "ETH"
    case arweave = "AR"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .icp: return "Internet Computer"
        case .ethereum: return "Ethereum"
        case .arweave: return "Arweave"
        }
    }

    var symbol: String { rawValue }

    var iconName: String {
        switch self {
        case .icp: return "infinity"
        case .ethereum: return "diamond.fill"
        case .arweave: return "archivebox.fill"
        }
    }

    var color: Color {
        switch self {
        case .icp: return Color(red: 0.24, green: 0.07, blue: 0.53)
        case .ethereum: return Color(red: 0.39, green: 0.46, blue: 0.84)
        case .arweave: return Color(red: 0.13, green: 0.13, blue: 0.13)
        }
    }

    var gradientColors: [Color] {
        switch self {
        case .icp:
            return [Color(red: 0.24, green: 0.07, blue: 0.53), Color(red: 0.58, green: 0.0, blue: 0.83)]
        case .ethereum:
            return [Color(red: 0.39, green: 0.46, blue: 0.84), Color(red: 0.25, green: 0.32, blue: 0.71)]
        case .arweave:
            return [Color(red: 0.13, green: 0.13, blue: 0.13), Color(red: 0.33, green: 0.33, blue: 0.33)]
        }
    }

    var derivationPath: String {
        switch self {
        case .icp: return "m/44'/223'/0'/0/0"
        case .ethereum: return "m/44'/60'/0'/0/0"
        case .arweave: return "" // Arweave uses RSA JWK, not HD derivation
        }
    }

    /// What import methods are available for this chain
    var supportedImportMethods: [ImportMethod] {
        switch self {
        case .icp: return [.mnemonic, .privateKey, .pemFile]
        case .ethereum: return [.mnemonic, .privateKey, .keystoreJSON]
        case .arweave: return [.jwkFile, .mnemonic]
        }
    }

    var addressPrefix: String {
        switch self {
        case .icp: return "Principal"
        case .ethereum: return "0x"
        case .arweave: return "ar://"
        }
    }

    var explorerURLBase: String? {
        switch self {
        case .icp: return "https://dashboard.internetcomputer.org/account/"
        case .ethereum: return "https://etherscan.io/address/"
        case .arweave: return "https://viewblock.io/arweave/address/"
        }
    }
}

/// Methods for importing an existing wallet
enum ImportMethod: String, CaseIterable, Identifiable {
    case mnemonic = "mnemonic"
    case privateKey = "private_key"
    case pemFile = "pem_file"
    case keystoreJSON = "keystore_json"
    case jwkFile = "jwk_file"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .mnemonic: return "Recovery Phrase"
        case .privateKey: return "Private Key"
        case .pemFile: return "PEM File"
        case .keystoreJSON: return "Keystore JSON"
        case .jwkFile: return "JWK Key File"
        }
    }

    var description: String {
        switch self {
        case .mnemonic: return "Enter your 12 or 24-word recovery phrase"
        case .privateKey: return "Paste your hex-encoded private key"
        case .pemFile: return "Select a PEM identity file"
        case .keystoreJSON: return "Select an Ethereum keystore JSON file"
        case .jwkFile: return "Select an Arweave JWK wallet file"
        }
    }

    var iconName: String {
        switch self {
        case .mnemonic: return "text.word.spacing"
        case .privateKey: return "key.fill"
        case .pemFile: return "doc.text.fill"
        case .keystoreJSON: return "lock.doc.fill"
        case .jwkFile: return "doc.badge.gearshape.fill"
        }
    }
}
