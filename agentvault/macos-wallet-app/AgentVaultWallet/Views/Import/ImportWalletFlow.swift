import SwiftUI
import UniformTypeIdentifiers

/// Multi-step wizard for importing an existing wallet
struct ImportWalletFlow: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @StateObject private var vm = ImportWalletViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            ScrollView {
                stepContent
                    .padding(24)
                    .frame(maxWidth: .infinity)
            }

            Divider()
            footer
        }
        .background(.background)
        .fileImporter(
            isPresented: $vm.showFileImporter,
            allowedContentTypes: vm.allowedFileTypes,
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                vm.selectedFileURL = urls.first
            case .failure(let error):
                vm.errorMessage = error.localizedDescription
            }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Text("Import Wallet")
                .font(.title2.bold())

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

        case .selectMethod:
            ImportMethodPickerView(
                methods: vm.availableMethods,
                selected: $vm.selectedMethod
            )

        case .enterInput:
            ImportInputView(vm: vm)

        case .nameWallet:
            WalletNameInputView(
                name: $vm.walletName,
                chain: vm.selectedChain,
                defaultName: "\(vm.selectedChain.displayName) Import"
            )

        case .importing:
            VStack(spacing: 20) {
                ProgressView()
                    .scaleEffect(1.5)
                Text("Importing your \(vm.selectedChain.displayName) wallet...")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 200)

        case .complete:
            ImportCompleteView(wallet: vm.importedWallet, chain: vm.selectedChain)
        }

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
            if vm.currentStep.rawValue > 0 && vm.currentStep != .importing && vm.currentStep != .complete {
                Button("Back") { vm.goBack() }
                    .buttonStyle(.bordered)
            }

            Spacer()

            if vm.currentStep == .complete {
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
            } else if vm.currentStep == .importing {
                // No buttons during import
            } else if vm.currentStep == .nameWallet {
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)

                    Button("Import") {
                        Task { await vm.importWallet(store: walletStore) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!vm.canProceed)
                }
            } else {
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)

                    Button("Next") { vm.goToNext() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!vm.canProceed)
                }
            }
        }
        .padding(16)
    }
}

// MARK: - Import Method Picker

struct ImportMethodPickerView: View {
    let methods: [ImportMethod]
    @Binding var selected: ImportMethod

    var body: some View {
        VStack(spacing: 16) {
            Text("How would you like to import?")
                .font(.headline)

            VStack(spacing: 10) {
                ForEach(methods) { method in
                    ImportMethodCard(method: method, isSelected: selected == method)
                        .onTapGesture { selected = method }
                }
            }
        }
    }
}

struct ImportMethodCard: View {
    let method: ImportMethod
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: method.iconName)
                .font(.title3)
            .foregroundStyle(.foreground)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 3) {
                Text(method.displayName)
                    .font(.headline)
                Text(method.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.foreground)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isSelected ? Color.accentColor : Color.secondary.opacity(0.2), lineWidth: isSelected ? 2 : 1)
        )
    }
}

// MARK: - Import Input

struct ImportInputView: View {
    @ObservedObject var vm: ImportWalletViewModel

    var body: some View {
        VStack(spacing: 20) {
            switch vm.selectedMethod {
            case .mnemonic:
                mnemonicInput

            case .privateKey:
                privateKeyInput

            case .jwkFile, .pemFile, .keystoreJSON:
                fileInput
            }
        }
    }

    private var mnemonicInput: some View {
        VStack(spacing: 16) {
            Text("Enter Recovery Phrase")
                .font(.headline)

            Text("Type or paste your 12 or 24-word recovery phrase below.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            TextEditor(text: $vm.inputText)
                .font(.system(.body, design: .monospaced))
                .frame(height: 100)
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.secondary.opacity(0.3))
                )
                .overlay(alignment: .topLeading) {
                    if vm.inputText.isEmpty {
                        Text(vm.inputPlaceholder)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .padding(12)
                            .allowsHitTesting(false)
                    }
                }

            // Word count indicator
            let wordCount = vm.inputText
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: .whitespaces)
                .filter { !$0.isEmpty }
                .count

            HStack {
                Text("\(wordCount) words")
                    .font(.caption)
                    .foregroundStyle(wordCount == 12 || wordCount == 24 ? .green : .secondary)

                Spacer()

                if wordCount > 0 && wordCount != 12 && wordCount != 24 {
                    Text("Expected 12 or 24 words")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private var privateKeyInput: some View {
        VStack(spacing: 16) {
            Text("Enter Private Key")
                .font(.headline)

            Text("Paste your private key below. It will be stored securely in your Mac's Keychain.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            SecureField(vm.inputPlaceholder, text: $vm.inputText)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))

            HStack {
                Image(systemName: "lock.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
                Text("Your private key is encrypted in the macOS Keychain")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var fileInput: some View {
        VStack(spacing: 16) {
            Text("Select \(vm.selectedMethod.displayName)")
                .font(.headline)

            if let url = vm.selectedFileURL {
                HStack {
                    Image(systemName: "doc.fill")
                        .foregroundStyle(.foreground)
                    Text(url.lastPathComponent)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()

                    Button("Change") {
                        vm.showFileImporter = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding()
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            } else {
                Button {
                    vm.showFileImporter = true
                } label: {
                    VStack(spacing: 12) {
                        Image(systemName: "doc.badge.plus")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text("Click to select a file")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Text(vm.selectedMethod.description)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 120)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                            .foregroundStyle(.secondary.opacity(0.3))
                    )
                }
                .buttonStyle(.plain)
            }

            // Password field for keystore files
            if vm.selectedMethod == .keystoreJSON {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Keystore Password")
                        .font(.callout.bold())
                    SecureField("Enter the password for this keystore file", text: $vm.passwordInput)
                        .textFieldStyle(.roundedBorder)
                }
            }
        }
    }
}

// MARK: - Import Complete

struct ImportCompleteView: View {
    let wallet: Wallet?
    let chain: Chain

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)

            Text("Wallet Imported!")
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
