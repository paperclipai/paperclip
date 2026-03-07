import SwiftUI

/// Backup creation workflow
struct BackupView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @StateObject private var vm = BackupViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 8) {
                Image(systemName: "arrow.down.doc.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.foreground)
                Text("Backup Wallets")
                    .font(.title2.bold())
                Text("Create an encrypted backup of your wallet keys")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 20)
            .padding(.bottom, 16)

            Divider()

            if vm.backupComplete {
                backupCompleteView
            } else {
                ScrollView {
                    VStack(spacing: 24) {
                        // Wallet selection
                        walletSelectionSection

                        // Password
                        passwordSection
                    }
                    .padding(24)
                }

                Divider()

                // Footer
                HStack {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("Create Backup") {
                        Task {
                            await vm.createBackup(wallets: walletStore.wallets)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!vm.canCreateBackup)
                }
                .padding(16)
            }
        }
        .frame(maxWidth: .infinity)
        .background(.background)
        .onAppear {
            vm.selectAllWallets(from: walletStore.wallets)
        }
        .alert("Backup Error", isPresented: Binding(
            get: { vm.errorMessage != nil },
            set: { if !$0 { vm.errorMessage = nil } }
        )) {
            Button("OK") { vm.errorMessage = nil }
        } message: {
            Text(vm.errorMessage ?? "")
        }
    }

    private var walletSelectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Select Wallets")
                    .font(.headline)
                Spacer()
                Button("Select All") { vm.selectAllWallets(from: walletStore.wallets) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.foreground)
                    .font(.caption)
                Text("/")
                    .foregroundStyle(.tertiary)
                    .font(.caption)
                Button("None") { vm.deselectAllWallets() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.foreground)
                    .font(.caption)
            }

            if walletStore.wallets.isEmpty {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text("No wallets to back up. Create or import a wallet first.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding()
                .frame(maxWidth: .infinity)
                .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            } else {
                VStack(spacing: 2) {
                    ForEach(walletStore.wallets) { wallet in
                        HStack(spacing: 12) {
                            Toggle("", isOn: Binding(
                                get: { vm.selectedWalletsForBackup.contains(wallet.id) },
                                set: { selected in
                                    if selected {
                                        vm.selectedWalletsForBackup.insert(wallet.id)
                                    } else {
                                        vm.selectedWalletsForBackup.remove(wallet.id)
                                    }
                                }
                            ))
                            .labelsHidden()

                            Image(systemName: wallet.chain.iconName)
                                .foregroundStyle(wallet.chain.color)

                            VStack(alignment: .leading) {
                                Text(wallet.name)
                                    .font(.callout)
                                Text(wallet.shortAddress)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Text(wallet.chain.symbol)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                }
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            }

            Text("\(vm.selectedWalletsForBackup.count) of \(walletStore.wallets.count) wallets selected")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var passwordSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Encryption Password")
                .font(.headline)

            Text("Choose a strong password to encrypt your backup. You'll need this password to restore.")
                .font(.caption)
                .foregroundStyle(.secondary)

            SecureField("Password (min 8 characters)", text: $vm.backupPassword)
                .textFieldStyle(.roundedBorder)

            // Password strength
            if !vm.backupPassword.isEmpty {
                HStack(spacing: 8) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(.quaternary)
                            RoundedRectangle(cornerRadius: 2)
                                .fill(vm.passwordStrength.color)
                                .frame(width: geo.size.width * vm.passwordStrength.progress)
                        }
                    }
                    .frame(height: 4)

                    Text(vm.passwordStrength.label)
                        .font(.caption2)
                        .foregroundStyle(vm.passwordStrength.color)
                        .frame(width: 50, alignment: .trailing)
                }
            }

            SecureField("Confirm password", text: $vm.backupPasswordConfirm)
                .textFieldStyle(.roundedBorder)

            if !vm.backupPasswordConfirm.isEmpty && vm.backupPassword != vm.backupPasswordConfirm {
                Text("Passwords do not match")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var backupCompleteView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)

            Text("Backup Created!")
                .font(.title2.bold())

            if let path = vm.backupFilePath {
                VStack(spacing: 8) {
                    Text("Saved to:")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text(path)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .padding(8)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                }

                Button("Reveal in Finder") {
                    NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            Spacer()

            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .padding(.bottom, 20)
        }
        .padding(24)
    }
}
