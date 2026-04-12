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
        issueID: String,
        companyId: String
    ) async throws -> IssueConsoleDetail

    func loadAgentDetail(
        configuration: ServerConnectionConfiguration,
        agentID: String
    ) async throws -> AgentConsoleDetail

    func loadApprovalDetail(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        companyId: String
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
        note: String?,
        companyId: String
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

    // MARK: - Extended features

    func listRoutines(configuration: ServerConnectionConfiguration, companyId: String) async throws -> [RoutineSummary]
    func loadRoutineDetail(configuration: ServerConnectionConfiguration, routineId: String) async throws -> RoutineDetail
    func triggerRoutineRun(configuration: ServerConnectionConfiguration, routineId: String) async throws -> RoutineDetail

    func loadCostSummary(configuration: ServerConnectionConfiguration, companyId: String) async throws -> CostSummarySnapshot
    func loadCostBreakdownByAgent(configuration: ServerConnectionConfiguration, companyId: String) async throws -> [CostBreakdownEntry]

    func listAdapters(configuration: ServerConnectionConfiguration) async throws -> [AdapterSummary]
    func toggleAdapterDisabled(configuration: ServerConnectionConfiguration, type: String, disabled: Bool) async throws -> [AdapterSummary]
    func installAdapter(configuration: ServerConnectionConfiguration, packageName: String, isLocalPath: Bool, version: String?) async throws
    func removeAdapter(configuration: ServerConnectionConfiguration, type: String) async throws

    func listCompanySkills(configuration: ServerConnectionConfiguration, companyId: String) async throws -> [CompanySkillSummary]

    func loadOrgTree(configuration: ServerConnectionConfiguration, companyId: String) async throws -> [OrgNode]
    func loadCompanySettings(configuration: ServerConnectionConfiguration, companyId: String) async throws -> CompanySettingsDetail
    func updateCompanySettings(configuration: ServerConnectionConfiguration, companyId: String, settings: CompanySettingsDraft) async throws -> CompanySettingsDetail

    func createIssue(configuration: ServerConnectionConfiguration, companyId: String, title: String, description: String?, priority: String?, assigneeAgentId: String?, projectId: String?, goalId: String?) async throws -> IssueQueueSummary
    func createAgent(configuration: ServerConnectionConfiguration, companyId: String, name: String, role: String?, adapterType: String, reportsTo: String?) async throws
}

public protocol ConnectionStateProviding: Sendable {
    func currentConnectionState(configuration: ServerConnectionConfiguration) async -> ConnectionState
}

public protocol InstanceSettingsProviding: Sendable {
    func loadInstanceSettings(configuration: ServerConnectionConfiguration) async throws -> InstanceSettingsSnapshot
    func updateGeneralSettings(
        configuration: ServerConnectionConfiguration,
        settings: InstanceGeneralSettingsSummary
    ) async throws -> InstanceGeneralSettingsSummary
    func updateExperimentalSettings(
        configuration: ServerConnectionConfiguration,
        settings: InstanceExperimentalSettingsSummary
    ) async throws -> InstanceExperimentalSettingsSummary
}

public protocol LocalServerControlling: Sendable {
    func currentStatus(configuration: ServerConnectionConfiguration) async -> LocalServerStatus
    func ensureRunning(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus
    func start(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus
    func restart(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus
    func stop() async -> LocalServerStatus
    func noteAPIReachable() async
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
    public let instanceSettings: any InstanceSettingsProviding
    public let localServer: any LocalServerControlling
    public let configurationStore: any DesktopConfigurationStoring
    public let loginItem: any LoginItemControlling
    public let notifications: any NotificationsAuthorizing
    public let localNetwork: any LocalNetworkDiscovering
    public let primaryNode: any PrimaryNodePromoting

    public init(
        operations: any OperationsSnapshotProviding,
        console: any OperationsConsoleProviding,
        connection: any ConnectionStateProviding,
        instanceSettings: any InstanceSettingsProviding,
        localServer: any LocalServerControlling,
        configurationStore: any DesktopConfigurationStoring,
        loginItem: any LoginItemControlling,
        notifications: any NotificationsAuthorizing,
        localNetwork: any LocalNetworkDiscovering,
        primaryNode: any PrimaryNodePromoting
    ) {
        self.operations = operations
        self.console = console
        self.connection = connection
        self.instanceSettings = instanceSettings
        self.localServer = localServer
        self.configurationStore = configurationStore
        self.loginItem = loginItem
        self.notifications = notifications
        self.localNetwork = localNetwork
        self.primaryNode = primaryNode
    }
}
