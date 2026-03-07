import SwiftUI

/// Manages the multi-step wallet creation flow
@MainActor
final class CreateWalletViewModel: ObservableObject {

    enum Step: Int, CaseIterable {
        case selectChain = 0
        case generating = 1
        case showMnemonic = 2
        case confirmMnemonic = 3
        case nameWallet = 4
        case complete = 5

        var title: String {
            switch self {
            case .selectChain: return "Select Network"
            case .generating: return "Generating Wallet"
            case .showMnemonic: return "Recovery Phrase"
            case .confirmMnemonic: return "Confirm Backup"
            case .nameWallet: return "Name Your Wallet"
            case .complete: return "Wallet Created"
            }
        }
    }

    @Published var currentStep: Step = .selectChain
    @Published var selectedChain: Chain = .ethereum
    @Published var walletName: String = ""
    @Published var mnemonic: String = ""
    @Published var mnemonicWords: [String] = []
    @Published var confirmationInput: String = ""
    @Published var confirmWordIndices: [Int] = []  // Which words to verify
    @Published var createdWallet: Wallet?
    @Published var isProcessing: Bool = false
    @Published var errorMessage: String?

    /// Words the user needs to confirm (randomly selected from the mnemonic)
    var wordsToConfirm: [(index: Int, word: String)] {
        confirmWordIndices.compactMap { idx in
            guard idx < mnemonicWords.count else { return nil }
            return (index: idx, word: mnemonicWords[idx])
        }
    }

    /// Whether the user can proceed from the current step
    var canProceed: Bool {
        switch currentStep {
        case .selectChain: return true
        case .generating: return false
        case .showMnemonic: return true
        case .confirmMnemonic: return isConfirmationValid
        case .nameWallet: return !walletName.trimmingCharacters(in: .whitespaces).isEmpty
        case .complete: return true
        }
    }

    /// Validate mnemonic confirmation
    var isConfirmationValid: Bool {
        let inputWords = confirmationInput
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }

        guard inputWords.count == confirmWordIndices.count else { return false }

        for (i, idx) in confirmWordIndices.enumerated() {
            guard i < inputWords.count, idx < mnemonicWords.count else { return false }
            if inputWords[i] != mnemonicWords[idx].lowercased() { return false }
        }
        return true
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

    /// Generate a new wallet using the CLI bridge
    func generateWallet(store: WalletStore) async {
        isProcessing = true
        errorMessage = nil
        currentStep = .generating

        do {
            let name = walletName.isEmpty ? "\(selectedChain.displayName) Wallet" : walletName
            let result = try await store.createWallet(chain: selectedChain, name: name)

            createdWallet = result.wallet
            if let m = result.mnemonic {
                mnemonic = m
                mnemonicWords = m.components(separatedBy: " ")
                selectRandomConfirmationWords()
            }

            isProcessing = false
            currentStep = .showMnemonic
        } catch {
            isProcessing = false
            errorMessage = error.localizedDescription
            currentStep = .selectChain
        }
    }

    /// Select 3 random word indices for confirmation
    private func selectRandomConfirmationWords() {
        guard mnemonicWords.count >= 3 else { return }
        var indices = Set<Int>()
        while indices.count < 3 {
            indices.insert(Int.random(in: 0..<mnemonicWords.count))
        }
        confirmWordIndices = indices.sorted()
    }

    func reset() {
        currentStep = .selectChain
        selectedChain = .ethereum
        walletName = ""
        mnemonic = ""
        mnemonicWords = []
        confirmationInput = ""
        confirmWordIndices = []
        createdWallet = nil
        isProcessing = false
        errorMessage = nil
    }
}
