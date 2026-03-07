import SwiftUI

/// Root view with sidebar navigation and main content area
struct MainView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var agentStore: AgentStore

    var body: some View {
        Group {
            if appState.isFirstLaunch {
                WelcomeView()
            } else {
                NavigationSplitView {
                    SidebarView()
                } detail: {
                    detailView
                }
                .sheet(item: $appState.activeSheet) { sheet in
                    sheetContent(for: sheet)
                }
                .alert(item: $appState.alert) { alert in
                    Alert(
                        title: Text(alert.title),
                        message: Text(alert.message),
                        dismissButton: .default(Text("OK"))
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch appState.selectedDestination {
        case .dashboard:
            DashboardView()
        case .walletList:
            WalletListView()
        case .walletDetail(let id):
            if let wallet = walletStore.wallets.first(where: { $0.id == id }) {
                WalletDetailView(wallet: wallet)
            } else {
                ContentUnavailableView("Wallet Not Found",
                    systemImage: "wallet.pass",
                    description: Text("This wallet may have been deleted."))
            }
        case .backup:
            BackupRestoreView()
        case .settings:
            SettingsView()
        case .agentHub:
            AgentHubView()
                .environmentObject(agentStore)
        case .chat:
            ChatView()
                .environmentObject(agentStore)
        case .iosGuild:
            iOSGuildView()
                .environmentObject(agentStore)
        }
    }

    @ViewBuilder
    private func sheetContent(for sheet: ActiveSheet) -> some View {
        switch sheet {
        case .createWallet:
            CreateWalletFlow()
                .frame(width: 560, height: 520)
        case .importWallet:
            ImportWalletFlow()
                .frame(width: 560, height: 520)
        case .backup:
            BackupView()
                .frame(width: 520, height: 480)
        case .restore:
            RestoreView()
                .frame(width: 520, height: 480)
        case .walletDetail(let wallet):
            WalletDetailView(wallet: wallet)
                .frame(width: 500, height: 400)
        case .mnemonicReveal(let id):
            if let wallet = walletStore.wallets.first(where: { $0.id == id }) {
                MnemonicRevealSheet(wallet: wallet)
                    .frame(width: 480, height: 400)
            }
        }
    }
}

/// Mnemonic reveal sheet with security confirmation
struct MnemonicRevealSheet: View {
    let wallet: Wallet
    @EnvironmentObject var walletStore: WalletStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmed = false
    @State private var mnemonic: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.system(size: 40))
                .foregroundStyle(.orange)

            Text("Reveal Recovery Phrase")
                .font(.title2.bold())

            Text("Your recovery phrase gives full access to this wallet. Never share it with anyone.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if let mnemonic = mnemonic {
                MnemonicGridView(words: mnemonic.components(separatedBy: " "))
                    .padding()

                Button("Copy to Clipboard") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(mnemonic, forType: .string)

                    // Auto-clear clipboard after 60 seconds
                    DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                        NSPasteboard.general.clearContents()
                    }
                }
                .buttonStyle(.bordered)
            } else {
                Toggle("I understand the risks of revealing my recovery phrase", isOn: $confirmed)
                    .padding(.horizontal)

                Button("Reveal Phrase") {
                    mnemonic = walletStore.getMnemonic(for: wallet)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!confirmed)
            }

            Button("Close") { dismiss() }
                .buttonStyle(.bordered)
        }
        .padding(24)
    }
}
