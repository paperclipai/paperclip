import SwiftUI

/// Detailed view for a single wallet
struct WalletDetailView: View {
    let wallet: Wallet
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @State private var isEditingName = false
    @State private var editedName: String = ""
    @State private var showDeleteConfirmation = false
    @State private var isRefreshing = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header card
                walletHeader

                // Address section
                addressSection

                // Balance section
                balanceSection

                // Details section
                detailsSection

                // Actions section
                actionsSection
            }
            .padding(24)
        }
        .navigationTitle(wallet.name)
        .confirmationDialog("Delete Wallet", isPresented: $showDeleteConfirmation) {
            Button("Delete \"\(wallet.name)\"", role: .destructive) {
                walletStore.deleteWallet(wallet)
                appState.selectedDestination = .walletList
            }
        } message: {
            Text("This will permanently delete the wallet and remove its keys from your Keychain. Make sure you have a backup of your recovery phrase.")
        }
    }

    private var walletHeader: some View {
        HStack(spacing: 20) {
            // Chain badge
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(
                        LinearGradient(colors: wallet.chain.gradientColors,
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .frame(width: 64, height: 64)

                Image(systemName: wallet.chain.iconName)
                    .font(.system(size: 28))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 6) {
                if isEditingName {
                    HStack {
                        TextField("Wallet name", text: $editedName)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit {
                                walletStore.renameWallet(wallet, to: editedName)
                                isEditingName = false
                            }
                        Button("Save") {
                            walletStore.renameWallet(wallet, to: editedName)
                            isEditingName = false
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                } else {
                    HStack {
                        Text(wallet.name)
                            .font(.title2.bold())

                        Button {
                            editedName = wallet.name
                            isEditingName = true
                        } label: {
                            Image(systemName: "pencil")
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 8) {
                    Text(wallet.chain.displayName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    if wallet.isImported {
                        Text("IMPORTED")
                            .font(.caption2.bold())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.secondary.opacity(0.15), in: Capsule())
                    }
                }
            }

            Spacer()
        }
        .padding(20)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
    }

    private var addressSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Address")
                .font(.headline)

            HStack {
                Text(wallet.address)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(2)
                    .textSelection(.enabled)

                Spacer()

                VStack(spacing: 6) {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(wallet.address, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Copy address to clipboard")

                    if let url = wallet.explorerURL {
                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            Image(systemName: "arrow.up.right.square")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("View on block explorer")
                    }
                }
            }
            .padding(16)
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.15)))
        }
    }

    private var balanceSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Balance")
                    .font(.headline)

                Spacer()

                Button {
                    isRefreshing = true
                    Task {
                        await walletStore.refreshBalance(for: wallet)
                        isRefreshing = false
                    }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isRefreshing)
            }

            HStack(alignment: .firstTextBaseline) {
                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text(wallet.cachedBalance ?? "—")
                        .font(.system(size: 36, weight: .semibold, design: .rounded).monospacedDigit())
                }

                Text(wallet.chain.symbol)
                    .font(.title2)
                    .foregroundStyle(.secondary)

                Spacer()

                if let updated = wallet.balanceLastUpdated {
                    Text("Updated \(updated, style: .relative) ago")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(16)
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.15)))
        }
    }

    private var detailsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Details")
                .font(.headline)

            VStack(spacing: 0) {
                DetailRow(label: "Network", value: wallet.chain.displayName)
                Divider().padding(.leading, 16)
                DetailRow(label: "Symbol", value: wallet.chain.symbol)
                Divider().padding(.leading, 16)
                if !wallet.derivationPath.isEmpty {
                    DetailRow(label: "Derivation Path", value: wallet.derivationPath)
                    Divider().padding(.leading, 16)
                }
                DetailRow(label: "Created", value: wallet.createdAt.formatted(date: .long, time: .shortened))
                Divider().padding(.leading, 16)
                DetailRow(label: "Recovery Phrase", value: wallet.hasMnemonicBackup ? "Backed up" : "Not available")
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.15)))
        }
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Actions")
                .font(.headline)

            HStack(spacing: 12) {
                if walletStore.hasMnemonic(for: wallet) {
                    Button {
                        appState.activeSheet = .mnemonicReveal(wallet.id)
                    } label: {
                        Label("Reveal Recovery Phrase", systemImage: "eye")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                Button {
                    appState.activeSheet = .backup
                } label: {
                    Label("Backup", systemImage: "arrow.down.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            Button(role: .destructive) {
                showDeleteConfirmation = true
            } label: {
                Label("Delete Wallet", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.red)
        }
    }
}

struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.callout)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
