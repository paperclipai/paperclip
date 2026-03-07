import SwiftUI

/// Multi-step wizard for creating a new wallet
struct CreateWalletFlow: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @StateObject private var vm = CreateWalletViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            // Header with step indicator
            header
            Divider()

            // Step content
            ScrollView {
                stepContent
                    .padding(24)
                    .frame(maxWidth: .infinity)
            }

            Divider()

            // Footer with navigation buttons
            footer
        }
        .background(.background)
    }

    private var header: some View {
        VStack(spacing: 12) {
            Text("Create New Wallet")
                .font(.title2.bold())

            // Step progress
            HStack(spacing: 4) {
                ForEach(0..<5) { step in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(step <= vm.currentStep.rawValue ? Color.accentColor : Color.secondary.opacity(0.2))
                        .frame(height: 3)
                }
            }
            .padding(.horizontal, 32)

            Text(vm.currentStep.title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch vm.currentStep {
        case .selectChain:
            ChainPickerView(selectedChain: $vm.selectedChain)

        case .generating:
            VStack(spacing: 20) {
                ProgressView()
                    .scaleEffect(1.5)
                Text("Generating your \(vm.selectedChain.displayName) wallet...")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 200)

        case .showMnemonic:
            MnemonicDisplayView(words: vm.mnemonicWords, chain: vm.selectedChain)

        case .confirmMnemonic:
            MnemonicConfirmView(
                confirmWordIndices: vm.confirmWordIndices,
                mnemonicWords: vm.mnemonicWords,
                confirmationInput: $vm.confirmationInput,
                isValid: vm.isConfirmationValid
            )

        case .nameWallet:
            WalletNameInputView(
                name: $vm.walletName,
                chain: vm.selectedChain,
                defaultName: "\(vm.selectedChain.displayName) Wallet"
            )

        case .complete:
            WalletCreatedView(wallet: vm.createdWallet, chain: vm.selectedChain)
        }

        // Error message
        if let error = vm.errorMessage {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
            }
            .padding()
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var footer: some View {
        HStack {
            if vm.currentStep != .selectChain && vm.currentStep != .generating && vm.currentStep != .complete {
                Button("Back") {
                    vm.goBack()
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            if vm.currentStep == .complete {
                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            } else if vm.currentStep == .selectChain {
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)

                    Button("Next") {
                        Task {
                            await vm.generateWallet(store: walletStore)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else if vm.currentStep == .showMnemonic {
                Button("I've Backed It Up") {
                    vm.goToNext()
                }
                .buttonStyle(.borderedProminent)
            } else if vm.currentStep == .confirmMnemonic {
                Button("Verify") {
                    if vm.isConfirmationValid {
                        vm.goToNext()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!vm.isConfirmationValid)
            } else if vm.currentStep == .nameWallet {
                Button("Finish") {
                    if let wallet = vm.createdWallet, !vm.walletName.isEmpty {
                        walletStore.renameWallet(wallet, to: vm.walletName)
                    }
                    vm.goToNext()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!vm.canProceed)
            }
        }
        .padding(16)
    }
}

// MARK: - Chain Picker

struct ChainPickerView: View {
    @Binding var selectedChain: Chain

    var body: some View {
        VStack(spacing: 16) {
            Text("Which blockchain network?")
                .font(.headline)

            VStack(spacing: 12) {
                ForEach(Chain.allCases) { chain in
                    ChainCard(chain: chain, isSelected: selectedChain == chain)
                        .onTapGesture { selectedChain = chain }
                }
            }
        }
    }
}

struct ChainCard: View {
    let chain: Chain
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(
                        LinearGradient(colors: chain.gradientColors, startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .frame(width: 48, height: 48)

                Image(systemName: chain.iconName)
                    .font(.title2)
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(chain.displayName)
                    .font(.headline)
                Text(chain.symbol)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.foreground)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(isSelected ? Color.accentColor : Color.secondary.opacity(0.2), lineWidth: isSelected ? 2 : 1)
        )
    }
}

// MARK: - Mnemonic Display

struct MnemonicDisplayView: View {
    let words: [String]
    let chain: Chain

    var body: some View {
        VStack(spacing: 20) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Write down these words in order. This is the ONLY way to recover your wallet.")
                    .font(.callout)
            }
            .padding()
            .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))

            MnemonicGridView(words: words)

            Button("Copy to Clipboard") {
                let phrase = words.joined(separator: " ")
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(phrase, forType: .string)

                // Auto-clear after 60 seconds
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                    NSPasteboard.general.clearContents()
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Text("Clipboard will be cleared automatically after 60 seconds.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

/// Grid display of mnemonic words with numbered positions
struct MnemonicGridView: View {
    let words: [String]

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 6) {
                    Text("\(index + 1)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .frame(width: 20, alignment: .trailing)

                    Text(word)
                        .font(.system(.body, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

// MARK: - Mnemonic Confirm

struct MnemonicConfirmView: View {
    let confirmWordIndices: [Int]
    let mnemonicWords: [String]
    @Binding var confirmationInput: String
    let isValid: Bool

    var body: some View {
        VStack(spacing: 20) {
            Text("Verify your backup")
                .font(.headline)

            Text("Enter the following words from your recovery phrase to confirm you've saved it.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 12) {
                ForEach(Array(confirmWordIndices.enumerated()), id: \.offset) { i, wordIndex in
                    HStack {
                        Text("Word #\(wordIndex + 1):")
                            .font(.callout.bold())
                            .frame(width: 80, alignment: .trailing)

                        TextField("Enter word", text: Binding(
                            get: {
                                let parts = confirmationInput.components(separatedBy: " ")
                                return i < parts.count ? parts[i] : ""
                            },
                            set: { newValue in
                                var parts = confirmationInput.components(separatedBy: " ")
                                while parts.count <= i { parts.append("") }
                                parts[i] = newValue.lowercased().trimmingCharacters(in: .whitespaces)
                                confirmationInput = parts.joined(separator: " ")
                            }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                    }
                }
            }
            .padding()
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))

            if isValid {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("All words match!")
                        .foregroundStyle(.green)
                }
            }
        }
    }
}

// MARK: - Wallet Name Input

struct WalletNameInputView: View {
    @Binding var name: String
    let chain: Chain
    let defaultName: String

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: chain.iconName)
                .font(.system(size: 40))
                .foregroundStyle(chain.color)

            Text("Name Your Wallet")
                .font(.headline)

            Text("Give your wallet a friendly name to identify it easily.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            TextField(defaultName, text: $name)
                .textFieldStyle(.roundedBorder)
                .font(.title3)
                .frame(maxWidth: 300)
                .multilineTextAlignment(.center)
                .onAppear {
                    if name.isEmpty { name = defaultName }
                }
        }
    }
}

// MARK: - Wallet Created Success

struct WalletCreatedView: View {
    let wallet: Wallet?
    let chain: Chain

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)

            Text("Wallet Created!")
                .font(.title2.bold())

            if let wallet = wallet {
                VStack(spacing: 12) {
                    WalletInfoRow(label: "Network", value: chain.displayName)
                    WalletInfoRow(label: "Name", value: wallet.name)
                    WalletInfoRow(label: "Address", value: wallet.shortAddress)
                }
                .padding()
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))

                Button("Copy Address") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(wallet.address, forType: .string)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }
}

struct WalletInfoRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
