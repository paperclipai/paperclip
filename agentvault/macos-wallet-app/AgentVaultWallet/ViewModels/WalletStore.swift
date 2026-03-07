import SwiftUI
import Combine

/// Central state manager for all wallet operations.
/// Acts as the single source of truth for wallet data in the app.
@MainActor
final class WalletStore: ObservableObject {

    @Published var wallets: [Wallet] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    @Published var selectedWalletId: UUID?

    private let fileService = FileService.shared
    private let keychain = KeychainService.shared
    private let cliBridge = CLIBridge.shared
    private let backupService = BackupService.shared

    // MARK: - Computed Properties

    var selectedWallet: Wallet? {
        guard let id = selectedWalletId else { return nil }
        return wallets.first { $0.id == id }
    }

    var walletsByChain: [Chain: [Wallet]] {
        Dictionary(grouping: wallets, by: \.chain)
    }

    var totalWalletCount: Int { wallets.count }

    var icpWallets: [Wallet] { wallets.filter { $0.chain == .icp } }
    var ethWallets: [Wallet] { wallets.filter { $0.chain == .ethereum } }
    var arweaveWallets: [Wallet] { wallets.filter { $0.chain == .arweave } }

    // MARK: - Persistence

    func loadWallets() {
        do {
            wallets = try fileService.loadWallets()
        } catch {
            errorMessage = "Failed to load wallets: \(error.localizedDescription)"
            wallets = []
        }
    }

    func saveWallets() {
        do {
            try fileService.saveWallets(wallets)
        } catch {
            errorMessage = "Failed to save wallets: \(error.localizedDescription)"
        }
    }

    // MARK: - Create Wallet

    /// Create a new wallet via the CLI bridge
    func createWallet(chain: Chain, name: String) async throws -> WalletCreationResult {
        isLoading = true
        defer { isLoading = false }

        let result = try await cliBridge.generateWallet(chain: chain, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: chain,
            address: result.address,
            isImported: false,
            derivationPath: chain.derivationPath,
            hasMnemonicBackup: result.mnemonic != nil
        )

        // Save secrets to Keychain
        if let mnemonic = result.mnemonic {
            try keychain.saveMnemonic(mnemonic, forWalletId: walletId)
        }
        if let privateKey = result.privateKey {
            try keychain.savePrivateKey(privateKey, forWalletId: walletId)
        }

        // Add to wallet list and persist
        wallets.append(wallet)
        saveWallets()

        return WalletCreationResult(
            wallet: wallet,
            mnemonic: result.mnemonic,
            privateKeyHex: result.privateKey,
            jwkData: nil
        )
    }

    // MARK: - Import Wallet

    /// Import a wallet from a mnemonic phrase
    func importFromMnemonic(chain: Chain, mnemonic: String, name: String) async throws -> Wallet {
        isLoading = true
        defer { isLoading = false }

        let result = try await cliBridge.importFromMnemonic(chain: chain, mnemonic: mnemonic, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: chain,
            address: result.address,
            isImported: true,
            derivationPath: chain.derivationPath,
            hasMnemonicBackup: true
        )

        try keychain.saveMnemonic(mnemonic, forWalletId: walletId)
        if let privateKey = result.privateKey {
            try keychain.savePrivateKey(privateKey, forWalletId: walletId)
        }

        wallets.append(wallet)
        saveWallets()
        return wallet
    }

    /// Import a wallet from a private key
    func importFromPrivateKey(chain: Chain, privateKey: String, name: String) async throws -> Wallet {
        isLoading = true
        defer { isLoading = false }

        let result = try await cliBridge.importFromPrivateKey(chain: chain, privateKey: privateKey, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: chain,
            address: result.address,
            isImported: true,
            derivationPath: chain.derivationPath,
            hasMnemonicBackup: false
        )

        try keychain.savePrivateKey(privateKey, forWalletId: walletId)

        wallets.append(wallet)
        saveWallets()
        return wallet
    }

    /// Import an Arweave wallet from a JWK file
    func importFromJWK(fileURL: URL, name: String) async throws -> Wallet {
        isLoading = true
        defer { isLoading = false }

        let jwkData = try FileService.shared.readJWKFile(at: fileURL)
        let result = try await cliBridge.importFromJWK(filePath: fileURL.path, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: .arweave,
            address: result.address,
            isImported: true,
            derivationPath: "",
            hasMnemonicBackup: false
        )

        try keychain.saveJWK(jwkData, forWalletId: walletId)

        wallets.append(wallet)
        saveWallets()
        return wallet
    }

    /// Import an ICP identity from a PEM file
    func importFromPEM(fileURL: URL, name: String) async throws -> Wallet {
        isLoading = true
        defer { isLoading = false }

        let pemContent = try FileService.shared.readPEMFile(at: fileURL)
        let result = try await cliBridge.importFromPEM(filePath: fileURL.path, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: .icp,
            address: result.address,
            isImported: true,
            derivationPath: Chain.icp.derivationPath,
            hasMnemonicBackup: false
        )

        try keychain.savePrivateKey(pemContent, forWalletId: walletId)

        wallets.append(wallet)
        saveWallets()
        return wallet
    }

    /// Import an Ethereum wallet from a keystore JSON
    func importFromKeystore(fileURL: URL, password: String, name: String) async throws -> Wallet {
        isLoading = true
        defer { isLoading = false }

        _ = try FileService.shared.readKeystoreFile(at: fileURL)
        let result = try await cliBridge.importFromKeystore(filePath: fileURL.path, password: password, name: name)

        let walletId = UUID()
        let wallet = Wallet(
            id: walletId,
            name: name,
            chain: .ethereum,
            address: result.address,
            isImported: true,
            derivationPath: Chain.ethereum.derivationPath,
            hasMnemonicBackup: false
        )

        if let privateKey = result.privateKey {
            try keychain.savePrivateKey(privateKey, forWalletId: walletId)
        }

        wallets.append(wallet)
        saveWallets()
        return wallet
    }

    // MARK: - Wallet Management

    /// Delete a wallet and all its associated secrets
    func deleteWallet(_ wallet: Wallet) {
        keychain.deleteAllSecrets(forWalletId: wallet.id)
        wallets.removeAll { $0.id == wallet.id }
        if selectedWalletId == wallet.id {
            selectedWalletId = nil
        }
        saveWallets()
    }

    /// Rename a wallet
    func renameWallet(_ wallet: Wallet, to newName: String) {
        guard let index = wallets.firstIndex(where: { $0.id == wallet.id }) else { return }
        wallets[index].name = newName
        saveWallets()
    }

    /// Refresh balance for a single wallet
    func refreshBalance(for wallet: Wallet) async {
        guard let index = wallets.firstIndex(where: { $0.id == wallet.id }) else { return }

        do {
            let balance = try await cliBridge.getBalance(chain: wallet.chain, address: wallet.address)
            wallets[index].cachedBalance = balance
            wallets[index].balanceLastUpdated = Date()
            saveWallets()
        } catch {
            // Silently fail balance refresh — don't disrupt the UI
        }
    }

    /// Refresh balances for all wallets
    func refreshAllBalances() async {
        isLoading = true
        defer { isLoading = false }

        await withTaskGroup(of: Void.self) { group in
            for wallet in wallets {
                group.addTask { [weak self] in
                    await self?.refreshBalance(for: wallet)
                }
            }
        }
    }

    /// Check if we have the mnemonic for a given wallet
    func hasMnemonic(for wallet: Wallet) -> Bool {
        keychain.hasMnemonic(forWalletId: wallet.id)
    }

    /// Retrieve mnemonic for a wallet (requires confirmation)
    func getMnemonic(for wallet: Wallet) -> String? {
        try? keychain.getMnemonic(forWalletId: wallet.id)
    }
}
