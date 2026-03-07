import SwiftUI

/// Shows all wallets grouped by chain with search and filtering
struct WalletListView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @State private var searchText = ""
    @State private var filterChain: Chain?
    @State private var sortOrder: WalletSortOrder = .name
    @State private var showDeleteConfirmation: Wallet?

    private var filteredWallets: [Wallet] {
        var results = walletStore.wallets

        // Filter by chain
        if let chain = filterChain {
            results = results.filter { $0.chain == chain }
        }

        // Filter by search text
        if !searchText.isEmpty {
            results = results.filter {
                $0.name.localizedCaseInsensitiveContains(searchText) ||
                $0.address.localizedCaseInsensitiveContains(searchText) ||
                $0.chain.displayName.localizedCaseInsensitiveContains(searchText)
            }
        }

        // Sort
        switch sortOrder {
        case .name:
            results.sort { $0.name.localizedCompare($1.name) == .orderedAscending }
        case .chain:
            results.sort { $0.chain.rawValue < $1.chain.rawValue }
        case .created:
            results.sort { $0.createdAt > $1.createdAt }
        }

        return results
    }

    var body: some View {
        VStack(spacing: 0) {
            // Toolbar
            toolbar

            if walletStore.wallets.isEmpty {
                emptyState
            } else if filteredWallets.isEmpty {
                noResultsState
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(filteredWallets) { wallet in
                            WalletRowView(wallet: wallet)
                                .onTapGesture {
                                    appState.selectedDestination = .walletDetail(wallet.id)
                                }
                                .contextMenu {
                                    walletContextMenu(wallet)
                                }
                        }
                    }
                    .padding(20)
                }
            }
        }
        .navigationTitle("All Wallets")
        .confirmationDialog(
            "Delete Wallet",
            isPresented: Binding(
                get: { showDeleteConfirmation != nil },
                set: { if !$0 { showDeleteConfirmation = nil } }
            ),
            presenting: showDeleteConfirmation
        ) { wallet in
            Button("Delete \"\(wallet.name)\"", role: .destructive) {
                walletStore.deleteWallet(wallet)
            }
        } message: { wallet in
            Text("This will permanently delete the wallet and its keys from your Keychain. This cannot be undone unless you have a backup.")
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            // Search
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search wallets...", text: $searchText)
                    .textFieldStyle(.plain)
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))

            // Chain filter
            Picker("Network", selection: $filterChain) {
                Text("All Networks").tag(Chain?.none)
                Divider()
                ForEach(Chain.allCases) { chain in
                    Label(chain.displayName, systemImage: chain.iconName)
                        .tag(Chain?.some(chain))
                }
            }
            .frame(width: 160)

            // Sort
            Picker("Sort", selection: $sortOrder) {
                ForEach(WalletSortOrder.allCases) { order in
                    Text(order.label).tag(order)
                }
            }
            .frame(width: 120)

            Spacer()

            // Refresh all balances
            Button {
                Task { await walletStore.refreshAllBalances() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(walletStore.isLoading)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Wallets Yet", systemImage: "wallet.pass")
        } description: {
            Text("Create or import a wallet to get started.")
        } actions: {
            HStack(spacing: 12) {
                Button("Create Wallet") {
                    appState.activeSheet = .createWallet
                }
                .buttonStyle(.borderedProminent)

                Button("Import Wallet") {
                    appState.activeSheet = .importWallet
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var noResultsState: some View {
        ContentUnavailableView.search(text: searchText)
    }

    @ViewBuilder
    private func walletContextMenu(_ wallet: Wallet) -> some View {
        Button("Copy Address") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(wallet.address, forType: .string)
        }

        if let url = wallet.explorerURL {
            Button("View on Explorer") {
                NSWorkspace.shared.open(url)
            }
        }

        if walletStore.hasMnemonic(for: wallet) {
            Button("Reveal Recovery Phrase") {
                appState.activeSheet = .mnemonicReveal(wallet.id)
            }
        }

        Divider()

        Button("Refresh Balance") {
            Task { await walletStore.refreshBalance(for: wallet) }
        }

        Divider()

        Button("Delete Wallet", role: .destructive) {
            showDeleteConfirmation = wallet
        }
    }
}

/// Wallet card row for the list view
struct WalletRowView: View {
    let wallet: Wallet
    @EnvironmentObject var walletStore: WalletStore

    var body: some View {
        HStack(spacing: 16) {
            // Chain icon
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(
                        LinearGradient(colors: wallet.chain.gradientColors,
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .frame(width: 44, height: 44)

                Image(systemName: wallet.chain.iconName)
                    .font(.title3)
                    .foregroundStyle(.white)
            }

            // Wallet info
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(wallet.name)
                        .font(.headline)

                    if wallet.isImported {
                        Text("IMPORTED")
                            .font(.caption2.bold())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.secondary.opacity(0.15), in: Capsule())
                    }
                }

                Text(wallet.shortAddress)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Balance
            VStack(alignment: .trailing, spacing: 4) {
                Text(wallet.displayBalance)
                    .font(.headline.monospacedDigit())

                if let updated = wallet.balanceLastUpdated {
                    Text(updated, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Arrow
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.secondary.opacity(0.1))
        )
        .shadow(color: .black.opacity(0.03), radius: 4, y: 2)
    }
}

enum WalletSortOrder: String, CaseIterable, Identifiable {
    case name, chain, created

    var id: String { rawValue }

    var label: String {
        switch self {
        case .name: return "Name"
        case .chain: return "Network"
        case .created: return "Date Created"
        }
    }
}
