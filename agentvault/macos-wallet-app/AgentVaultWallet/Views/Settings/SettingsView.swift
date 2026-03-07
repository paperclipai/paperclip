import SwiftUI

/// Application settings
struct SettingsView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @State private var showPurgeConfirmation = false
    @State private var showResetConfirmation = false
    @State private var customCLIPath: String = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // General
                settingsSection("General") {
                    VStack(spacing: 0) {
                        SettingsRow(label: "Default Network") {
                            Picker("", selection: $appState.defaultChain) {
                                ForEach(Chain.allCases) { chain in
                                    Text(chain.displayName).tag(chain.rawValue)
                                }
                            }
                            .frame(width: 180)
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "Auto-refresh Balances") {
                            Toggle("", isOn: $appState.autoRefreshBalances)
                                .labelsHidden()
                        }
                    }
                    .settingsCard()
                }

                // Environment
                settingsSection("Environment") {
                    VStack(spacing: 0) {
                        SettingsRow(label: "Node.js") {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(appState.environment.nodeInstalled ? .green : .red)
                                    .frame(width: 8, height: 8)
                                Text(appState.environment.nodeVersion ?? "Not installed")
                                    .font(.callout.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "npm") {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(appState.environment.npmInstalled ? .green : .red)
                                    .frame(width: 8, height: 8)
                                Text(appState.environment.npmInstalled ? "Installed" : "Not installed")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "AgentVault CLI") {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(appState.environment.agentVaultInstalled ? .green : .red)
                                    .frame(width: 8, height: 8)
                                Text(appState.environment.agentVaultInstalled ? "Available" : "Not found")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "CLI Path Override") {
                            HStack {
                                TextField("Auto-detect", text: $customCLIPath)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 200)
                                Button("Apply") {
                                    appState.setCLIPath(customCLIPath)
                                    appState.checkEnvironment()
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                Button("Browse") {
                                    let panel = NSOpenPanel()
                                    panel.canChooseFiles = false
                                    panel.canChooseDirectories = true
                                    panel.allowsMultipleSelection = false
                                    panel.prompt = "Select AgentVault Directory"
                                    if panel.runModal() == .OK, let url = panel.url {
                                        customCLIPath = url.path
                                        appState.setCLIPath(url.path)
                                        appState.checkEnvironment()
                                    }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                    .settingsCard()

                    Button("Re-check Environment") {
                        appState.checkEnvironment()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(appState.isCheckingEnvironment)
                }

                // Security
                settingsSection("Security") {
                    VStack(spacing: 0) {
                        SettingsRow(label: "Wallet Count") {
                            Text("\(walletStore.totalWalletCount)")
                                .foregroundStyle(.secondary)
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "Storage") {
                            Text("macOS Keychain")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "Encryption") {
                            Text("AES-256-GCM")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .settingsCard()
                }

                // Data management
                settingsSection("Data Management") {
                    VStack(spacing: 0) {
                        SettingsRow(label: "Data Location") {
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.selectFile(nil,
                                    inFileViewerRootedAtPath: FileService.shared.appDataDirectory.path)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }

                        Divider().padding(.leading, 16)

                        SettingsRow(label: "Backup Directory") {
                            Button("Open") {
                                NSWorkspace.shared.selectFile(nil,
                                    inFileViewerRootedAtPath: BackupService.shared.defaultBackupDirectory.path)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    .settingsCard()
                }

                // Danger zone
                settingsSection("Danger Zone") {
                    VStack(spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Purge All Keychain Data")
                                    .font(.callout.bold())
                                Text("Remove all wallet secrets from the macOS Keychain.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Purge", role: .destructive) {
                                showPurgeConfirmation = true
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                            .controlSize(.small)
                        }

                        Divider()

                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Reset Application")
                                    .font(.callout.bold())
                                Text("Delete all wallets, settings, and cached data. This cannot be undone.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Reset", role: .destructive) {
                                showResetConfirmation = true
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                            .controlSize(.small)
                        }
                    }
                    .padding(16)
                    .background(.red.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.red.opacity(0.2)))
                }

                // About
                settingsSection("About") {
                    VStack(spacing: 0) {
                        SettingsRow(label: "Version") {
                            Text("1.0.0")
                                .foregroundStyle(.secondary)
                        }
                        Divider().padding(.leading, 16)
                        SettingsRow(label: "Platform") {
                            Text("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .settingsCard()
                }
            }
            .padding(24)
        }
        .navigationTitle("Settings")
        .onAppear {
            customCLIPath = appState.cliPath
        }
        .confirmationDialog("Purge Keychain", isPresented: $showPurgeConfirmation) {
            Button("Purge All Secrets", role: .destructive) {
                KeychainService.shared.purgeAll()
                appState.showSuccess("All Keychain data has been purged.")
            }
        } message: {
            Text("This will delete ALL wallet private keys and mnemonics from the Keychain. Make sure you have backups!")
        }
        .confirmationDialog("Reset Application", isPresented: $showResetConfirmation) {
            Button("Reset Everything", role: .destructive) {
                KeychainService.shared.purgeAll()
                walletStore.wallets.removeAll()
                walletStore.saveWallets()
                appState.hasCompletedOnboarding = false
                appState.isFirstLaunch = true
            }
        } message: {
            Text("This will delete all wallets, purge the Keychain, and reset the app to its initial state. This CANNOT be undone.")
        }
    }

    private func settingsSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
        }
    }
}

struct SettingsRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            content()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

extension View {
    func settingsCard() -> some View {
        self
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.secondary.opacity(0.15)))
    }
}
