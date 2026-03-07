import SwiftUI
import UniformTypeIdentifiers

/// Manages the multi-step wallet import flow
@MainActor
final class ImportWalletViewModel: ObservableObject {

    enum Step: Int, CaseIterable {
        case selectChain = 0
        case selectMethod = 1
        case enterInput = 2
        case nameWallet = 3
        case importing = 4
        case complete = 5

        var title: String {
            switch self {
            case .selectChain: return "Select Network"
            case .selectMethod: return "Import Method"
            case .enterInput: return "Enter Details"
            case .nameWallet: return "Name Your Wallet"
            case .importing: return "Importing"
            case .complete: return "Import Complete"
            }
        }
    }

    @Published var currentStep: Step = .selectChain
    @Published var selectedChain: Chain = .ethereum
    @Published var selectedMethod: ImportMethod = .mnemonic
    @Published var walletName: String = ""
    @Published var inputText: String = ""        // Mnemonic or private key
    @Published var passwordInput: String = ""     // For keystore files
    @Published var selectedFileURL: URL?          // For file-based imports
    @Published var importedWallet: Wallet?
    @Published var isProcessing: Bool = false
    @Published var errorMessage: String?
    @Published var showFileImporter: Bool = false

    /// Available import methods for the selected chain
    var availableMethods: [ImportMethod] {
        selectedChain.supportedImportMethods
    }

    /// Whether the current input is valid enough to proceed
    var isInputValid: Bool {
        switch selectedMethod {
        case .mnemonic:
            return CryptoService.shared.isValidMnemonic(inputText)
        case .privateKey:
            let cleaned = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
            if selectedChain == .ethereum {
                return CryptoService.shared.isValidEthPrivateKey(cleaned)
            }
            return cleaned.count >= 32
        case .pemFile, .jwkFile, .keystoreJSON:
            return selectedFileURL != nil
        }
    }

    var canProceed: Bool {
        switch currentStep {
        case .selectChain: return true
        case .selectMethod: return true
        case .enterInput: return isInputValid
        case .nameWallet: return !walletName.trimmingCharacters(in: .whitespaces).isEmpty
        case .importing: return false
        case .complete: return true
        }
    }

    /// File types accepted for the current import method
    var allowedFileTypes: [UTType] {
        switch selectedMethod {
        case .jwkFile: return [.json]
        case .pemFile: return [UTType(filenameExtension: "pem") ?? .data]
        case .keystoreJSON: return [.json]
        default: return []
        }
    }

    /// Placeholder text for the input field
    var inputPlaceholder: String {
        switch selectedMethod {
        case .mnemonic: return "Enter your 12 or 24-word recovery phrase, separated by spaces..."
        case .privateKey:
            if selectedChain == .ethereum { return "Enter your hex-encoded private key (0x...)" }
            return "Enter your private key..."
        default: return ""
        }
    }

    func goToNext() {
        guard let nextStep = Step(rawValue: currentStep.rawValue + 1) else { return }
        withAnimation(.easeInOut(duration: 0.3)) {
            currentStep = nextStep
        }
    }

    func goBack() {
        guard let prevStep = Step(rawValue: currentStep.rawValue - 1) else { return }
        withAnimation(.easeInOut(duration: 0.3)) {
            currentStep = prevStep
        }
    }

    /// Execute the import
    func importWallet(store: WalletStore) async {
        isProcessing = true
        errorMessage = nil
        currentStep = .importing

        do {
            let name = walletName.isEmpty ? "\(selectedChain.displayName) Import" : walletName

            switch selectedMethod {
            case .mnemonic:
                importedWallet = try await store.importFromMnemonic(
                    chain: selectedChain,
                    mnemonic: inputText.trimmingCharacters(in: .whitespacesAndNewlines),
                    name: name
                )

            case .privateKey:
                importedWallet = try await store.importFromPrivateKey(
                    chain: selectedChain,
                    privateKey: inputText.trimmingCharacters(in: .whitespacesAndNewlines),
                    name: name
                )

            case .jwkFile:
                guard let url = selectedFileURL else { throw ImportError.noFileSelected }
                importedWallet = try await store.importFromJWK(fileURL: url, name: name)

            case .pemFile:
                guard let url = selectedFileURL else { throw ImportError.noFileSelected }
                importedWallet = try await store.importFromPEM(fileURL: url, name: name)

            case .keystoreJSON:
                guard let url = selectedFileURL else { throw ImportError.noFileSelected }
                importedWallet = try await store.importFromKeystore(
                    fileURL: url,
                    password: passwordInput,
                    name: name
                )
            }

            isProcessing = false
            currentStep = .complete
        } catch {
            isProcessing = false
            errorMessage = error.localizedDescription
            currentStep = .enterInput
        }
    }

    func reset() {
        currentStep = .selectChain
        selectedChain = .ethereum
        selectedMethod = .mnemonic
        walletName = ""
        inputText = ""
        passwordInput = ""
        selectedFileURL = nil
        importedWallet = nil
        isProcessing = false
        errorMessage = nil
    }

    enum ImportError: LocalizedError {
        case noFileSelected

        var errorDescription: String? {
            switch self {
            case .noFileSelected: return "No file was selected for import"
            }
        }
    }
}
