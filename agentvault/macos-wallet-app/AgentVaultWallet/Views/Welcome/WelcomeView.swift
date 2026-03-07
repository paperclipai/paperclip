import SwiftUI

/// First-launch onboarding experience
struct WelcomeView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @State private var currentPage = 0

    private let pages = [
        OnboardingPage(
            icon: "shield.checkered",
            title: "Welcome to AgentVault Wallet",
            subtitle: "A secure, friendly wallet manager for your blockchain assets.",
            description: "Manage wallets for Internet Computer, Ethereum, and Arweave — no terminal required."
        ),
        OnboardingPage(
            icon: "key.viewfinder",
            title: "Your Keys, Your Control",
            subtitle: "Private keys never leave your Mac.",
            description: "All secrets are stored in the macOS Keychain, protected by your system password and the Secure Enclave."
        ),
        OnboardingPage(
            icon: "arrow.triangle.2.circlepath.icloud",
            title: "Backup & Restore",
            subtitle: "Encrypted backups keep you safe.",
            description: "Create password-protected backups of all your wallets. Restore them on any Mac with AgentVault Wallet."
        ),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Page content
            TabView(selection: $currentPage) {
                ForEach(Array(pages.enumerated()), id: \.offset) { index, page in
                    VStack(spacing: 24) {
                        // Icon
                        ZStack {
                            Circle()
                                .fill(.ultraThinMaterial)
                                .frame(width: 100, height: 100)

                            Image(systemName: page.icon)
                                .font(.system(size: 44))
                                .foregroundStyle(.primary)
                        }

                        // Title
                        Text(page.title)
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .multilineTextAlignment(.center)

                        // Subtitle
                        Text(page.subtitle)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)

                        // Description
                        Text(page.description)
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 420)
                            .padding(.top, 4)
                    }
                    .padding(40)
                    .tag(index)
                }
            }
            .tabViewStyle(.automatic)

            Spacer()

            // Progress dots
            HStack(spacing: 8) {
                ForEach(0..<pages.count, id: \.self) { index in
                    Circle()
                        .fill(index == currentPage ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                        .animation(.easeInOut, value: currentPage)
                }
            }
            .padding(.bottom, 24)

            // Environment status
            if appState.isCheckingEnvironment {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking environment...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 16)
            } else if !appState.environment.nodeInstalled {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("Node.js not detected. Some features may be limited.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 16)
            }

            // Actions
            VStack(spacing: 12) {
                if currentPage < pages.count - 1 {
                    Button {
                        withAnimation { currentPage += 1 }
                    } label: {
                        Text("Next")
                            .frame(width: 200)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button("Skip") {
                        appState.completeOnboarding()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                } else {
                    Button {
                        appState.completeOnboarding()
                        appState.activeSheet = .createWallet
                    } label: {
                        Text("Create Your First Wallet")
                            .frame(width: 240)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    HStack(spacing: 16) {
                        Button("Import Existing Wallet") {
                            appState.completeOnboarding()
                            appState.activeSheet = .importWallet
                        }
                        .buttonStyle(.bordered)

                        Button("Restore from Backup") {
                            appState.completeOnboarding()
                            appState.activeSheet = .restore
                        }
                        .buttonStyle(.bordered)
                    }

                    Button("Skip for Now") {
                        appState.completeOnboarding()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                }
            }
            .padding(.bottom, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.05), Color.clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }
}

struct OnboardingPage {
    let icon: String
    let title: String
    let subtitle: String
    let description: String
}
