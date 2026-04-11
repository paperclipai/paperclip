import Foundation
import NeurOSAppCore

public protocol OperationsSnapshotProviding: Sendable {
    func loadSnapshot(
        configuration: ServerConnectionConfiguration,
        selectedCompanyID: String?
    ) async throws -> OperationsSnapshot
}

public protocol OperationsConsoleProviding: Sendable {
    func loadIssueDetail(
        configuration: ServerConnectionConfiguration,
        issueID: String
    ) async throws -> IssueConsoleDetail

    func loadAgentDetail(
        configuration: ServerConnectionConfiguration,
        agentID: String
    ) async throws -> AgentConsoleDetail

    func loadApprovalDetail(
        configuration: ServerConnectionConfiguration,
        approvalID: String
    ) async throws -> ApprovalDetail

    func addApprovalComment(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        body: String
    ) async throws -> ApprovalCommentEntry

    func performApprovalAction(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        action: ApprovalDecisionAction,
        note: String?
    ) async throws -> ApprovalDetail

    func loadPluginConsoleSnapshot(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        logLimit: Int
    ) async throws -> PluginConsoleSnapshot

    func setPluginEnabled(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        isEnabled: Bool,
        reason: String?
    ) async throws -> PluginDetail

    func upgradePlugin(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        targetVersion: String?
    ) async throws -> PluginDetail

    func loadProjectWorkspaces(
        configuration: ServerConnectionConfiguration,
        projectID: String
    ) async throws -> [ProjectWorkspaceDetail]

    func performWorkspaceRuntimeAction(
        configuration: ServerConnectionConfiguration,
        projectID: String,
        workspaceID: String,
        action: WorkspaceRuntimeAction
    ) async throws -> WorkspaceRuntimeActionResult
}

public protocol ConnectionStateProviding: Sendable {
    func currentConnectionState(configuration: ServerConnectionConfiguration) async -> ConnectionState
}

public protocol LoginItemControlling: Sendable {
    func setEnabled(_ isEnabled: Bool) async throws
}

public protocol NotificationsAuthorizing: Sendable {
    func requestAuthorizationIfNeeded() async
}

public protocol LocalNetworkDiscovering: Sendable {
    func discoverPeers() async -> [String]
}

public protocol PrimaryNodePromoting: Sendable {
    func promoteCurrentMac() async throws -> ConnectionState
}

public struct DesktopServices: Sendable {
    public let operations: any OperationsSnapshotProviding
    public let console: any OperationsConsoleProviding
    public let connection: any ConnectionStateProviding
    public let configurationStore: any DesktopConfigurationStoring
    public let loginItem: any LoginItemControlling
    public let notifications: any NotificationsAuthorizing
    public let localNetwork: any LocalNetworkDiscovering
    public let primaryNode: any PrimaryNodePromoting

    public init(
        operations: any OperationsSnapshotProviding,
        console: any OperationsConsoleProviding,
        connection: any ConnectionStateProviding,
        configurationStore: any DesktopConfigurationStoring,
        loginItem: any LoginItemControlling,
        notifications: any NotificationsAuthorizing,
        localNetwork: any LocalNetworkDiscovering,
        primaryNode: any PrimaryNodePromoting
    ) {
        self.operations = operations
        self.console = console
        self.connection = connection
        self.configurationStore = configurationStore
        self.loginItem = loginItem
        self.notifications = notifications
        self.localNetwork = localNetwork
        self.primaryNode = primaryNode
    }
}
