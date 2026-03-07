import SwiftUI

/// Main dashboard showing wallet overview and quick actions
struct DashboardView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Hero header
                heroSection

                // Quick actions
                quickActions

                // Network overview
                if !walletStore.wallets.isEmpty {
                    networkOverview
                }

                // Recent wallets
                if !walletStore.wallets.isEmpty {
                    recentWallets
                }
            }
            .padding(24)
        }
        .navigationTitle("Dashboard")
    }

    private var heroSection: some View {
        VStack(spacing: 16) {
            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("AgentVault Wallet")
                        .font(.system(size: 28, weight: .bold, design: .rounded))

                    Text("Manage your blockchain wallets securely")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Stats
                HStack(spacing: 24) {
                    StatCard(value: "\(walletStore.totalWalletCount)", label: "Wallets", icon: "wallet.pass.fill")
                    StatCard(value: "\(Set(walletStore.wallets.map(\.chain)).count)", label: "Networks", icon: "network")
                }
            }
            .padding(24)
            .background(
                LinearGradient(
                    colors: [Color.accentColor.opacity(0.08), Color.accentColor.opacity(0.03)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.accentColor.opacity(0.15))
            )
        }
    }

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Quick Actions")
                .font(.headline)

            HStack(spacing: 12) {
                ActionCard(
                    title: "Create Wallet",
                    description: "Generate a new wallet",
                    icon: "plus.circle.fill",
                    color: .blue
                ) {
                    appState.activeSheet = .createWallet
                }

                ActionCard(
                    title: "Import Wallet",
                    description: "From phrase, key, or file",
                    icon: "square.and.arrow.down.fill",
                    color: .green
                ) {
                    appState.activeSheet = .importWallet
                }

                ActionCard(
                    title: "Backup",
                    description: "Secure your wallets",
                    icon: "arrow.down.doc.fill",
                    color: .orange
                ) {
                    appState.activeSheet = .backup
                }

                ActionCard(
                    title: "Restore",
                    description: "From backup file",
                    icon: "arrow.uturn.backward.circle.fill",
                    color: .purple
                ) {
                    appState.activeSheet = .restore
                }
            }
        }
    }

    private var networkOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Networks")
                .font(.headline)

            HStack(spacing: 12) {
                ForEach(Chain.allCases) { chain in
                    let chainWallets = walletStore.wallets.filter { $0.chain == chain }

                    VStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(
                                    LinearGradient(colors: chain.gradientColors,
                                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                                )
                                .frame(width: 44, height: 44)

                            Image(systemName: chain.iconName)
                                .font(.title3)
                                .foregroundStyle(.white)
                        }

                        Text(chain.displayName)
                            .font(.callout.bold())

                        Text("\(chainWallets.count) wallet\(chainWallets.count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(16)
                    .background(.background, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.1)))
                }
            }
        }
    }

    private var recentWallets: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Your Wallets")
                    .font(.headline)
                Spacer()
                Button("View All") {
                    appState.selectedDestination = .walletList
                }
                .buttonStyle(.plain)
                .foregroundStyle(.foreground)
                .font(.callout)
            }

            let recent = Array(walletStore.wallets.prefix(5))
            VStack(spacing: 8) {
                ForEach(recent) { wallet in
                    WalletRowView(wallet: wallet)
                        .onTapGesture {
                            appState.selectedDestination = .walletDetail(wallet.id)
                        }
                }
            }
        }
    }
}

// MARK: - Supporting Views

struct StatCard: View {
    let value: String
    let label: String
    let icon: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.foreground)
            Text(value)
                .font(.title.bold().monospacedDigit())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(width: 80)
    }
}

struct ActionCard: View {
    let title: String
    let description: String
    let icon: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(color)

                VStack(spacing: 2) {
                    Text(title)
                        .font(.callout.bold())
                    Text(description)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.secondary.opacity(0.15))
            )
        }
        .buttonStyle(.plain)
    }
}
