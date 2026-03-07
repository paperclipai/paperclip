import SwiftUI

/// Navigation sidebar with wallet groups and actions
struct SidebarView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var agentStore: AgentStore

    var body: some View {
        List(selection: $appState.selectedDestination) {
            // Main navigation
            Section {
                NavigationLink(value: NavigationDestination.dashboard) {
                    Label("Dashboard", systemImage: "square.grid.2x2")
                }

                NavigationLink(value: NavigationDestination.walletList) {
                    Label {
                        HStack {
                            Text("All Wallets")
                            Spacer()
                            Text("\(walletStore.totalWalletCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                    } icon: {
                        Image(systemName: "wallet.pass.fill")
                    }
                }
            }

            // Agents
            Section("Agents") {
                NavigationLink(value: NavigationDestination.agentHub) {
                    Label {
                        HStack {
                            Text("Agent Hub")
                            Spacer()
                            if !agentStore.agents.isEmpty {
                                Text("\(agentStore.agents.count)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                    } icon: {
                        Image(systemName: "cpu")
                    }
                }

                NavigationLink(value: NavigationDestination.chat) {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }

                NavigationLink(value: NavigationDestination.iosGuild) {
                    Label {
                        HStack {
                            Text("iOS Guild")
                            Spacer()
                            let iosAgentCount = agentStore.agents
                                .filter { $0.environment["AGENTVAULT_DOMAIN"] == "ios" }.count
                            if iosAgentCount > 0 {
                                Text("\(iosAgentCount)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                    } icon: {
                        Image(systemName: "iphone")
                            .foregroundStyle(.blue)
                    }
                }

                // Quick links to individual agents
                if !agentStore.primaryAgents.isEmpty {
                    ForEach(agentStore.primaryAgents.prefix(5)) { agent in
                        NavigationLink(value: NavigationDestination.agentHub) {
                            AgentSidebarRow(agent: agent)
                        }
                    }
                }
            }

            // Wallets by chain
            Section("Networks") {
                ForEach(Chain.allCases) { chain in
                    DisclosureGroup {
                        let chainWallets = walletStore.wallets.filter { $0.chain == chain }
                        if chainWallets.isEmpty {
                            Text("No wallets")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.leading, 4)
                        } else {
                            ForEach(chainWallets) { wallet in
                                NavigationLink(value: NavigationDestination.walletDetail(wallet.id)) {
                                    WalletSidebarRow(wallet: wallet)
                                }
                            }
                        }
                    } label: {
                        Label {
                            HStack {
                                Text(chain.displayName)
                                Spacer()
                                Text("\(walletStore.wallets.filter { $0.chain == chain }.count)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: chain.iconName)
                                .foregroundStyle(chain.color)
                        }
                    }
                }
            }

            // Tools
            Section("Tools") {
                NavigationLink(value: NavigationDestination.backup) {
                    Label("Backup & Restore", systemImage: "arrow.triangle.2.circlepath")
                }

                NavigationLink(value: NavigationDestination.settings) {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            sidebarActions
        }
        .navigationSplitViewColumnWidth(min: 220, ideal: 260)
    }

    private var sidebarActions: some View {
        VStack(spacing: 8) {
            Divider()

            HStack(spacing: 12) {
                Button {
                    appState.activeSheet = .createWallet
                } label: {
                    Label("Create", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)

                Button {
                    appState.activeSheet = .importWallet
                } label: {
                    Label("Import", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .background(.bar)
    }
}

/// Compact agent row for the sidebar
struct AgentSidebarRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: agent.agentType.iconName)
                .font(.caption)
                .foregroundStyle(agent.agentType.color)
                .frame(width: 14)

            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name)
                    .font(.body)
                    .lineLimit(1)
                Text(agent.model)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Circle()
                .fill(agent.status.color)
                .frame(width: 6, height: 6)
        }
        .padding(.vertical, 2)
    }
}

/// Compact wallet row for the sidebar
struct WalletSidebarRow: View {
    let wallet: Wallet

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(wallet.name)
                .font(.body)
                .lineLimit(1)

            Text(wallet.shortAddress)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}
