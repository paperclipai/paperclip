import Foundation

/// Application-wide constants
enum AppConstants {
    static let appName = "AgentVault Wallet"
    static let appVersion = "1.0.0"
    static let buildNumber = "1"

    /// Keychain service identifier
    static let keychainService = "com.agentvault.wallet"

    /// Backup file extension
    static let backupFileExtension = "avbackup"

    /// Minimum password length for backups
    static let minimumBackupPasswordLength = 8

    /// How long to keep clipboard data before auto-clearing (seconds)
    static let clipboardClearDelay: TimeInterval = 60

    /// Maximum wallets per chain (soft limit)
    static let maxWalletsPerChain = 50

    /// Supported mnemonic word counts
    static let supportedMnemonicLengths: Set<Int> = [12, 24]

    /// Network endpoints (for reference; actual connections go through CLI)
    enum Networks {
        static let icpMainnet = "https://ic0.app"
        static let icpLocal = "http://127.0.0.1:4943"
        static let ethMainnet = "https://eth.llamarpc.com"
        static let ethSepolia = "https://rpc.sepolia.org"
        static let arweaveGateway = "https://arweave.net"
    }

    /// UserDefaults keys
    enum Defaults {
        static let hasCompletedOnboarding = "hasCompletedOnboarding"
        static let agentVaultCLIPath = "agentVaultCLIPath"
        static let autoRefreshBalances = "autoRefreshBalances"
        static let defaultChain = "defaultChain"
        static let lastBackupDate = "lastBackupDate"
    }
}
