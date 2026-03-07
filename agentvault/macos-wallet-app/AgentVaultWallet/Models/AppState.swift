import SwiftUI
import Combine

/// Sheets/modals the app can present
enum ActiveSheet: Identifiable {
    case createWallet
    case importWallet
    case backup
    case restore
    case walletDetail(Wallet)
    case mnemonicReveal(UUID)

    var id: String {
        switch self {
        case .createWallet: return "create"
        case .importWallet: return "import"
        case .backup: return "backup"
        case .restore: return "restore"
        case .walletDetail(let w): return "detail-\(w.id)"
        case .mnemonicReveal(let id): return "mnemonic-\(id)"
        }
    }
}

/// Navigation destinations for the sidebar
enum NavigationDestination: Hashable {
    case dashboard
    case walletList
    case walletDetail(UUID)
    case backup
    case settings
    // Agent management & chat
    case agentHub
    case chat
    // iOS-specific Guild
    case iosGuild
}

/// Alert types
struct AlertInfo: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let style: AlertStyle

    enum AlertStyle {
        case info, success, warning, error
    }
}

/// Environment health check results
struct EnvironmentStatus {
    var nodeInstalled: Bool = false
    var nodeVersion: String?
    var npmInstalled: Bool = false
    var agentVaultInstalled: Bool = false
    var agentVaultVersion: String?
    var isReady: Bool { nodeInstalled && npmInstalled }
}

/// Global application state
@MainActor
final class AppState: ObservableObject {
    @Published var activeSheet: ActiveSheet?
    @Published var selectedDestination: NavigationDestination = .dashboard
    @Published var alert: AlertInfo?
    @Published var isFirstLaunch: Bool = true
    @Published var environment = EnvironmentStatus()
    @Published var isCheckingEnvironment: Bool = false

    @AppStorage("hasCompletedOnboarding") var hasCompletedOnboarding: Bool = false
    @AppStorage("agentVaultCLIPath") var cliPath: String = ""
    @AppStorage("autoRefreshBalances") var autoRefreshBalances: Bool = true
    @AppStorage("defaultChain") var defaultChain: String = Chain.ethereum.rawValue

    private let cliBridge = CLIBridge.shared

    init() {
        isFirstLaunch = !hasCompletedOnboarding
    }

    func completeOnboarding() {
        hasCompletedOnboarding = true
        isFirstLaunch = false
    }

    func checkEnvironment() {
        isCheckingEnvironment = true
        let path = cliPath.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await cliBridge.setProjectRoot(path)
            let env = await cliBridge.checkEnvironment()
            self.environment = env
            self.isCheckingEnvironment = false
        }
    }

    func setCLIPath(_ path: String) {
        cliPath = path
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await cliBridge.setProjectRoot(trimmed)
        }
    }

    func showAlert(title: String, message: String, style: AlertInfo.AlertStyle = .info) {
        alert = AlertInfo(title: title, message: message, style: style)
    }

    func showError(_ message: String) {
        showAlert(title: "Error", message: message, style: .error)
    }

    func showSuccess(_ message: String) {
        showAlert(title: "Success", message: message, style: .success)
    }
}
