import SwiftUI

/// Manages backup and restore workflows
@MainActor
final class BackupViewModel: ObservableObject {

    // MARK: - Backup State

    @Published var backupPassword: String = ""
    @Published var backupPasswordConfirm: String = ""
    @Published var selectedWalletsForBackup: Set<UUID> = []
    @Published var isCreatingBackup: Bool = false
    @Published var backupComplete: Bool = false
    @Published var backupFilePath: String?

    // MARK: - Restore State

    @Published var restoreFileURL: URL?
    @Published var restorePassword: String = ""
    @Published var backupMetadata: WalletBackup?
    @Published var isRestoring: Bool = false
    @Published var restoreComplete: Bool = false
    @Published var restoredCount: Int = 0

    // MARK: - Common

    @Published var errorMessage: String?
    @Published var showFileImporter: Bool = false
    @Published var showFileSaver: Bool = false
    @Published var existingBackups: [BackupFileInfo] = []

    private let backupService = BackupService.shared

    // MARK: - Backup Validation

    var isBackupPasswordValid: Bool {
        backupPassword.count >= 8 && backupPassword == backupPasswordConfirm
    }

    var hasSelectedWallets: Bool {
        !selectedWalletsForBackup.isEmpty
    }

    var canCreateBackup: Bool {
        isBackupPasswordValid && hasSelectedWallets && !isCreatingBackup
    }

    var passwordStrength: PasswordStrength {
        PasswordStrength.evaluate(backupPassword)
    }

    // MARK: - Restore Validation

    var canRestore: Bool {
        restoreFileURL != nil && !restorePassword.isEmpty && !isRestoring
    }

    var hasBackupMetadata: Bool {
        backupMetadata != nil
    }

    // MARK: - Backup Operations

    func selectAllWallets(from wallets: [Wallet]) {
        selectedWalletsForBackup = Set(wallets.map(\.id))
    }

    func deselectAllWallets() {
        selectedWalletsForBackup.removeAll()
    }

    func createBackup(wallets: [Wallet]) async {
        isCreatingBackup = true
        errorMessage = nil

        do {
            let walletsToBackup = wallets.filter { selectedWalletsForBackup.contains($0.id) }
            let data = try backupService.createBackup(wallets: walletsToBackup, password: backupPassword)

            let filename = backupService.defaultBackupFilename()
            let fileURL = backupService.defaultBackupDirectory.appendingPathComponent(filename)

            try backupService.writeBackup(data, to: fileURL)

            backupFilePath = fileURL.path
            backupComplete = true
            isCreatingBackup = false
        } catch {
            errorMessage = error.localizedDescription
            isCreatingBackup = false
        }
    }

    /// Save backup to a user-chosen location
    func saveBackupToLocation(wallets: [Wallet], url: URL) async {
        isCreatingBackup = true
        errorMessage = nil

        do {
            let walletsToBackup = wallets.filter { selectedWalletsForBackup.contains($0.id) }
            let data = try backupService.createBackup(wallets: walletsToBackup, password: backupPassword)
            try backupService.writeBackup(data, to: url)

            backupFilePath = url.path
            backupComplete = true
            isCreatingBackup = false
        } catch {
            errorMessage = error.localizedDescription
            isCreatingBackup = false
        }
    }

    // MARK: - Restore Operations

    func loadBackupMetadata() {
        guard let url = restoreFileURL else { return }
        errorMessage = nil

        do {
            backupMetadata = try backupService.readBackupMetadata(from: url)
        } catch {
            errorMessage = error.localizedDescription
            backupMetadata = nil
        }
    }

    func restoreFromBackup(store: WalletStore) async {
        guard let backup = backupMetadata else { return }
        isRestoring = true
        errorMessage = nil

        do {
            let secrets = try backupService.restoreSecrets(from: backup, password: restorePassword)
            try backupService.saveRestoredSecrets(secrets)

            // Re-create wallet entries
            var restored = 0
            for entry in backup.wallets {
                // Skip if wallet already exists
                if store.wallets.contains(where: { $0.address == entry.address && $0.chain == entry.chain }) {
                    continue
                }

                let wallet = Wallet(
                    id: entry.id,
                    name: entry.name,
                    chain: entry.chain,
                    address: entry.address,
                    isImported: true,
                    derivationPath: entry.derivationPath,
                    hasMnemonicBackup: entry.hasMnemonicBackup
                )
                store.wallets.append(wallet)
                restored += 1
            }

            store.saveWallets()
            restoredCount = restored
            restoreComplete = true
            isRestoring = false
        } catch {
            errorMessage = error.localizedDescription
            isRestoring = false
        }
    }

    func loadExistingBackups() {
        existingBackups = backupService.listBackups()
    }

    func reset() {
        backupPassword = ""
        backupPasswordConfirm = ""
        selectedWalletsForBackup.removeAll()
        isCreatingBackup = false
        backupComplete = false
        backupFilePath = nil
        restoreFileURL = nil
        restorePassword = ""
        backupMetadata = nil
        isRestoring = false
        restoreComplete = false
        restoredCount = 0
        errorMessage = nil
    }
}

/// Password strength indicator
enum PasswordStrength {
    case weak, fair, good, strong

    var label: String {
        switch self {
        case .weak: return "Weak"
        case .fair: return "Fair"
        case .good: return "Good"
        case .strong: return "Strong"
        }
    }

    var color: Color {
        switch self {
        case .weak: return .red
        case .fair: return .orange
        case .good: return .yellow
        case .strong: return .green
        }
    }

    var progress: Double {
        switch self {
        case .weak: return 0.25
        case .fair: return 0.5
        case .good: return 0.75
        case .strong: return 1.0
        }
    }

    static func evaluate(_ password: String) -> PasswordStrength {
        guard !password.isEmpty else { return .weak }

        var score = 0
        if password.count >= 8 { score += 1 }
        if password.count >= 12 { score += 1 }
        if password.rangeOfCharacter(from: .uppercaseLetters) != nil { score += 1 }
        if password.rangeOfCharacter(from: .lowercaseLetters) != nil { score += 1 }
        if password.rangeOfCharacter(from: .decimalDigits) != nil { score += 1 }
        if password.rangeOfCharacter(from: CharacterSet(charactersIn: "!@#$%^&*()_+-=[]{}|;:,.<>?")) != nil { score += 1 }

        switch score {
        case 0...2: return .weak
        case 3: return .fair
        case 4...5: return .good
        default: return .strong
        }
    }
}
