import Foundation
import NeurOSAppCore

private struct HealthDTO: Decodable, Sendable {
    let status: String
    let version: String
    let deploymentMode: String?
    let deploymentExposure: String?
}

private struct DashboardDTO: Decodable, Sendable {
    struct Agents: Decodable, Sendable { let active: Int; let running: Int; let paused: Int; let error: Int }
    struct Tasks: Decodable, Sendable { let open: Int; let inProgress: Int; let blocked: Int; let done: Int }
    struct Costs: Decodable, Sendable { let monthSpendCents: Int; let monthBudgetCents: Int; let monthUtilizationPercent: Double }
    struct Budgets: Decodable, Sendable { let activeIncidents: Int; let pausedProjects: Int }

    let agents: Agents
    let tasks: Tasks
    let costs: Costs
    let pendingApprovals: Int
    let budgets: Budgets
}

private struct CompanyStatsDTO: Decodable, Sendable {
    let agentCount: Int
    let issueCount: Int
}

private struct CompanyDTO: Decodable, Sendable {
    let id: String
    let name: String
    let status: String
}

private struct ApprovalDTO: Decodable, Sendable {
    let id: String
    let type: String
    let status: String
    let payload: [String: JSONValue]
    let createdAt: Date
}

private struct ActivityDTO: Decodable, Sendable {
    let id: String
    let actorType: String
    let actorId: String
    let action: String
    let entityType: String
    let entityId: String
    let details: [String: JSONValue]?
    let createdAt: Date
}

private struct ApprovalDetailDTO: Decodable, Sendable {
    let id: String
    let type: String
    let status: String
    let requestedByAgentId: String?
    let requestedByUserId: String?
    let payload: [String: JSONValue]
    let decisionNote: String?
    let decidedAt: Date?
    let createdAt: Date
    let updatedAt: Date
}

private struct ApprovalCommentDTO: Decodable, Sendable {
    let id: String
    let authorAgentId: String?
    let authorUserId: String?
    let body: String
    let createdAt: Date
}

private struct AgentDTO: Decodable, Sendable {
    let id: String
    let name: String
    let role: String
    let status: String
    let spentMonthlyCents: Int
}

private struct IssueDTO: Decodable, Sendable {
    let id: String
    let title: String
    let status: String
    let priority: String
    let identifier: String?
    let assigneeAgentId: String?
    let updatedAt: Date
}

private struct IssueReferenceDTO: Decodable, Sendable {
    let id: String
    let identifier: String?
    let title: String
    let status: String
    let priority: String
    let assigneeAgentId: String?
    let assigneeUserId: String?
}

private struct IssueAncestorDTO: Decodable, Sendable {
    struct GoalDTO: Decodable, Sendable {
        let id: String
        let title: String
    }

    let id: String
    let title: String
    let goal: GoalDTO?
}

private struct IssueDetailDTO: Decodable, Sendable {
    struct ProjectDTO: Decodable, Sendable {
        let id: String
        let name: String
    }

    struct GoalDTO: Decodable, Sendable {
        let id: String
        let title: String
    }

    let id: String
    let title: String
    let description: String?
    let status: String
    let priority: String
    let identifier: String?
    let assigneeAgentId: String?
    let assigneeUserId: String?
    let ancestors: [IssueAncestorDTO]?
    let blockedBy: [IssueReferenceDTO]?
    let blocks: [IssueReferenceDTO]?
    let project: ProjectDTO?
    let goal: GoalDTO?
    let createdAt: Date
    let updatedAt: Date
}

private struct GoalDTO: Decodable, Sendable {
    let id: String
    let title: String
    let description: String?
    let level: String
    let status: String
    let parentId: String?
    let ownerAgentId: String?
    let createdAt: Date
    let updatedAt: Date
}

private struct ProjectDTO: Decodable, Sendable {
    let id: String
    let name: String
    let status: String
    let goalIds: [String]
    let workspaces: [ProjectWorkspaceDTO]
    let targetDate: String?
}

private struct ProjectWorkspaceDTO: Decodable, Sendable {
    let id: String
}

private struct PluginDTO: Decodable, Sendable {
    struct ManifestDTO: Decodable, Sendable {
        let name: String?
        let displayName: String?
    }

    let id: String
    let pluginKey: String
    let packageName: String
    let version: String
    let status: String
    let manifestJson: ManifestDTO?
}

private struct AgentChainEntryDTO: Decodable, Sendable {
    let id: String
    let name: String
    let role: String
    let title: String?
}

private struct AgentAccessDTO: Decodable, Sendable {
    let canAssignTasks: Bool
    let taskAssignSource: String
}

private struct AgentDetailDTO: Decodable, Sendable {
    let id: String
    let name: String
    let role: String
    let title: String?
    let status: String
    let adapterType: String
    let budgetMonthlyCents: Int
    let spentMonthlyCents: Int
    let pauseReason: String?
    let lastHeartbeatAt: Date?
    let chainOfCommand: [AgentChainEntryDTO]
    let access: AgentAccessDTO
}

private struct PluginDetailDTO: Decodable, Sendable {
    struct ManifestDTO: Decodable, Sendable {
        struct UIDTO: Decodable, Sendable {
            let slots: [PluginSlotDTO]?
            let launchers: [PluginLauncherDTO]?
        }

        struct PluginSlotDTO: Decodable, Sendable { let id: String? }
        struct PluginLauncherDTO: Decodable, Sendable { let id: String? }

        let name: String?
        let displayName: String?
        let categories: [String]?
        let launchers: [PluginLauncherDTO]?
        let ui: UIDTO?
    }

    let id: String
    let pluginKey: String
    let packageName: String
    let version: String
    let apiVersion: Int
    let status: String
    let installOrder: Int?
    let packagePath: String?
    let lastError: String?
    let installedAt: Date
    let updatedAt: Date
    let supportsConfigTest: Bool?
    let manifestJson: ManifestDTO?
}

private struct PluginHealthDTO: Decodable, Sendable {
    struct CheckDTO: Decodable, Sendable {
        let name: String
        let passed: Bool
        let message: String?
    }

    let pluginId: String
    let status: String
    let healthy: Bool
    let checks: [CheckDTO]
    let lastError: String?
}

private struct PluginLogDTO: Decodable, Sendable {
    let id: String
    let level: String
    let message: String
    let meta: [String: JSONValue]?
    let createdAt: Date
}

private struct ProjectWorkspaceDetailDTO: Decodable, Sendable {
    struct RuntimeConfigDTO: Decodable, Sendable {
        let desiredState: String?
    }

    struct RuntimeServiceDTO: Decodable, Sendable {
        let id: String
        let serviceName: String
        let status: String
        let lifecycle: String
        let port: Int?
        let url: String?
        let healthStatus: String
    }

    let id: String
    let name: String
    let sourceType: String
    let cwd: String?
    let repoUrl: String?
    let repoRef: String?
    let defaultRef: String?
    let visibility: String
    let runtimeConfig: RuntimeConfigDTO?
    let isPrimary: Bool
    let runtimeServices: [RuntimeServiceDTO]?
    let updatedAt: Date
}

private struct WorkspaceRuntimeOperationDTO: Decodable, Sendable {
    let status: String
    let stdout: String?
    let stderr: String?
    let system: String?
    let metadata: [String: JSONValue]?
}

private struct WorkspaceRuntimeActionResponseDTO: Decodable, Sendable {
    let workspace: ProjectWorkspaceDetailDTO
    let operation: WorkspaceRuntimeOperationDTO
}

private struct ApprovalCommentRequest: Encodable, Sendable {
    let body: String
}

private struct ApprovalActionRequest: Encodable, Sendable {
    let decidedByUserId: String
    let decisionNote: String?
}

private struct PluginDisableRequest: Encodable, Sendable {
    let reason: String?
}

private struct PluginUpgradeRequest: Encodable, Sendable {
    let version: String?
}

private actor PaperclipAPIClient {
    private let configuration: ServerConnectionConfiguration
    private let session: URLSession

    init(configuration: ServerConnectionConfiguration) {
        self.configuration = configuration
        self.session = .shared
    }

    func health() async throws -> HealthDTO {
        try await get("health")
    }

    func companies() async throws -> [CompanyDTO] {
        try await get("companies")
    }

    func companyStats() async throws -> [String: CompanyStatsDTO] {
        try await get("companies/stats")
    }

    func dashboard(companyId: String) async throws -> DashboardDTO {
        try await get("companies/\(companyId)/dashboard")
    }

    func approvals(companyId: String) async throws -> [ApprovalDTO] {
        try await get("companies/\(companyId)/approvals?status=pending")
    }

    func activity(companyId: String) async throws -> [ActivityDTO] {
        try await get("companies/\(companyId)/activity")
    }

    func approval(id: String) async throws -> ApprovalDetailDTO {
        try await get("approvals/\(id)")
    }

    func issue(id: String) async throws -> IssueDetailDTO {
        try await get("issues/\(id)")
    }

    func approvalIssues(id: String) async throws -> [IssueDTO] {
        try await get("approvals/\(id)/issues")
    }

    func approvalComments(id: String) async throws -> [ApprovalCommentDTO] {
        try await get("approvals/\(id)/comments")
    }

    func addApprovalComment(id: String, body: String) async throws -> ApprovalCommentDTO {
        try await post("approvals/\(id)/comments", body: ApprovalCommentRequest(body: body))
    }

    func performApprovalAction(
        id: String,
        action: ApprovalDecisionAction,
        note: String?
    ) async throws -> ApprovalDetailDTO {
        switch action {
        case .approve:
            return try await post(
                "approvals/\(id)/approve",
                body: ApprovalActionRequest(decidedByUserId: "board", decisionNote: note)
            )
        case .reject:
            return try await post(
                "approvals/\(id)/reject",
                body: ApprovalActionRequest(decidedByUserId: "board", decisionNote: note)
            )
        case .requestRevision:
            return try await post(
                "approvals/\(id)/request-revision",
                body: ApprovalActionRequest(decidedByUserId: "board", decisionNote: note)
            )
        case .resubmit:
            return try await post("approvals/\(id)/resubmit", body: EmptyRequest())
        }
    }

    func agents(companyId: String) async throws -> [AgentDTO] {
        try await get("companies/\(companyId)/agents")
    }

    func agent(id: String) async throws -> AgentDetailDTO {
        try await get("agents/\(id)")
    }

    func issues(companyId: String) async throws -> [IssueDTO] {
        try await get("companies/\(companyId)/issues")
    }

    func goals(companyId: String) async throws -> [GoalDTO] {
        try await get("companies/\(companyId)/goals")
    }

    func projects(companyId: String) async throws -> [ProjectDTO] {
        try await get("companies/\(companyId)/projects")
    }

    func plugins() async throws -> [PluginDTO] {
        try await get("plugins")
    }

    func plugin(id: String) async throws -> PluginDetailDTO {
        try await get("plugins/\(id)")
    }

    func pluginHealth(id: String) async throws -> PluginHealthDTO {
        try await get("plugins/\(id)/health")
    }

    func pluginLogs(id: String, limit: Int) async throws -> [PluginLogDTO] {
        try await get("plugins/\(id)/logs?limit=\(limit)")
    }

    func setPluginEnabled(id: String, isEnabled: Bool, reason: String?) async throws -> PluginDetailDTO {
        if isEnabled {
            return try await post("plugins/\(id)/enable", body: EmptyRequest())
        }
        return try await post("plugins/\(id)/disable", body: PluginDisableRequest(reason: reason))
    }

    func upgradePlugin(id: String, targetVersion: String?) async throws -> PluginDetailDTO {
        try await post("plugins/\(id)/upgrade", body: PluginUpgradeRequest(version: targetVersion))
    }

    func projectWorkspaces(id: String) async throws -> [ProjectWorkspaceDetailDTO] {
        try await get("projects/\(id)/workspaces")
    }

    func performWorkspaceRuntimeAction(
        projectID: String,
        workspaceID: String,
        action: WorkspaceRuntimeAction
    ) async throws -> WorkspaceRuntimeActionResponseDTO {
        try await post(
            "projects/\(projectID)/workspaces/\(workspaceID)/runtime-services/\(action.rawValue)",
            body: EmptyRequest()
        )
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let url = try makeURL(path: path)
        let (data, response) = try await session.data(from: url)

        return try decodeResponse(data: data, response: response, url: url)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let url = try makeURL(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try Self.encoder.encode(body)

        let (data, response) = try await session.data(for: request)
        return try decodeResponse(data: data, response: response, url: url)
    }

    private func makeURL(path: String) throws -> URL {
        guard let baseURL = configuration.apiBaseURL else {
            throw URLError(.badURL)
        }

        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let url = URL(string: normalizedPath, relativeTo: baseURL)?.absoluteURL else {
            throw URLError(.badURL)
        }
        return url
    }

    private func decodeResponse<T: Decodable>(
        data: Data,
        response: URLResponse,
        url: URL
    ) throws -> T {

        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw NSError(
                domain: "io.goldneuron.neurOS.network",
                code: httpResponse.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Resposta HTTP \(httpResponse.statusCode) em \(url.absoluteString)"]
            )
        }

        return try Self.decoder.decode(T.self, from: data)
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = PaperclipAPIClient.parseISO8601Date(value) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 date: \(value)")
        }
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static func parseISO8601Date(_ value: String) -> Date? {
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractionalFormatter.date(from: value) {
            return date
        }

        let formatter = ISO8601DateFormatter()
        return formatter.date(from: value)
    }
}

private struct EmptyRequest: Encodable, Sendable {}

public actor PaperclipDesktopService: OperationsSnapshotProviding, OperationsConsoleProviding, ConnectionStateProviding {
    public init() {}

    public func currentConnectionState(configuration: ServerConnectionConfiguration) async -> ConnectionState {
        guard let apiBaseURL = configuration.apiBaseURL else {
            return .degraded(message: "URL da instância inválida.")
        }

        let client = PaperclipAPIClient(configuration: configuration)
        do {
            _ = try await client.health()
            let host = apiBaseURL.host ?? configuration.trimmedBaseURLString
            let localHosts = ["127.0.0.1", "localhost", "::1"]
            return localHosts.contains(host) ? .local(nodeName: host) : .remote(hostname: host)
        } catch {
            return .degraded(message: error.localizedDescription)
        }
    }

    public func loadSnapshot(
        configuration: ServerConnectionConfiguration,
        selectedCompanyID: String?
    ) async throws -> OperationsSnapshot {
        let client = PaperclipAPIClient(configuration: configuration)
        async let healthTask = client.health()
        async let pluginsTask = client.plugins()
        async let companiesTask = client.companies()
        async let statsTask = client.companyStats()

        let companies = try await companiesTask
        let stats = try await statsTask
        let selectedID = selectedCompanyID ?? companies.first?.id

        guard let selectedID else {
            let plugins = try await pluginsTask
            let health = try await healthTask
            return OperationsSnapshot(
                companies: [],
                selectedCompanyID: nil,
                dashboard: nil,
                approvals: [],
                activity: [],
                signals: [],
                agents: [],
                issues: [],
                goals: [],
                projects: [],
                plugins: plugins.map(Self.mapPlugin),
                health: Self.mapHealth(health)
            )
        }

        async let dashboardTask = client.dashboard(companyId: selectedID)
        async let approvalsTask = client.approvals(companyId: selectedID)
        async let activityTask = client.activity(companyId: selectedID)
        async let agentsTask = client.agents(companyId: selectedID)
        async let issuesTask = client.issues(companyId: selectedID)
        async let goalsTask = client.goals(companyId: selectedID)
        async let projectsTask = client.projects(companyId: selectedID)

        let dashboard = try await dashboardTask
        let approvals = try await approvalsTask
        let activity = try await activityTask
        let agents = try await agentsTask
        let issues = try await issuesTask
        let goals = try await goalsTask
        let projects = try await projectsTask
        let health = try await healthTask
        let plugins = try await pluginsTask

        let mappedCompanies = companies.map { company in
            let counts = stats[company.id]
            return CompanySummary(
                id: company.id,
                name: company.name,
                status: company.status,
                projectsCount: company.id == selectedID ? projects.count : 0,
                activeIssuesCount: counts?.issueCount ?? 0,
                activeAgentsCount: counts?.agentCount ?? 0,
                recentSignalsCount: company.id == selectedID ? max(dashboard.pendingApprovals, dashboard.budgets.activeIncidents) : 0
            )
        }

        let agentSummaries = agents.map { agent in
            let activeIssue = issues.first(where: {
                $0.assigneeAgentId == agent.id && ["done", "cancelled"].contains($0.status) == false
            })
            return AgentRuntimeSummary(
                id: agent.id,
                name: agent.name,
                role: agent.role,
                stateLabel: agent.status,
                issueLabel: activeIssue?.identifier ?? activeIssue?.title ?? "Sem issue ativa",
                budgetLabel: Self.formatCurrency(cents: agent.spentMonthlyCents)
            )
        }

        let signals = Self.buildSignals(health: health, dashboard: dashboard, approvals: approvals, issueCount: issues.count)
        let agentNamesByID = Dictionary(uniqueKeysWithValues: agents.map { ($0.id, $0.name) })
        let goalSummaries = goals
            .sorted(by: { lhs, rhs in
                if lhs.createdAt == rhs.createdAt {
                    return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
                }
                return lhs.createdAt < rhs.createdAt
            })
            .map { Self.mapGoal($0, agentNamesByID: agentNamesByID) }

        return OperationsSnapshot(
            companies: mappedCompanies,
            selectedCompanyID: selectedID,
            dashboard: DashboardSummary(
                openTasks: dashboard.tasks.open,
                inProgressTasks: dashboard.tasks.inProgress,
                blockedTasks: dashboard.tasks.blocked,
                doneTasks: dashboard.tasks.done,
                activeAgents: dashboard.agents.active,
                runningAgents: dashboard.agents.running,
                pausedAgents: dashboard.agents.paused,
                erroredAgents: dashboard.agents.error,
                pendingApprovals: dashboard.pendingApprovals,
                monthSpendCents: dashboard.costs.monthSpendCents,
                monthBudgetCents: dashboard.costs.monthBudgetCents,
                monthUtilizationPercent: dashboard.costs.monthUtilizationPercent,
                activeBudgetIncidents: dashboard.budgets.activeIncidents,
                pausedProjects: dashboard.budgets.pausedProjects
            ),
            approvals: approvals.map(Self.mapApproval),
            activity: activity
                .sorted(by: { $0.createdAt > $1.createdAt })
                .prefix(40)
                .map(Self.mapActivity),
            signals: signals,
            agents: agentSummaries,
            issues: issues
                .filter { ["done", "cancelled"].contains($0.status) == false }
                .sorted(by: { $0.updatedAt > $1.updatedAt })
                .prefix(24)
                .map(Self.mapIssue),
            goals: goalSummaries,
            projects: projects.map(Self.mapProject),
            plugins: plugins.map(Self.mapPlugin),
            health: Self.mapHealth(health)
        )
    }

    public func loadApprovalDetail(
        configuration: ServerConnectionConfiguration,
        approvalID: String
    ) async throws -> ApprovalDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        async let approvalTask = client.approval(id: approvalID)
        async let issuesTask = client.approvalIssues(id: approvalID)
        async let commentsTask = client.approvalComments(id: approvalID)

        let approval = try await approvalTask
        let issues = try await issuesTask
        let comments = try await commentsTask

        return Self.mapApprovalDetail(approval, issues: issues, comments: comments)
    }

    public func loadIssueDetail(
        configuration: ServerConnectionConfiguration,
        issueID: String
    ) async throws -> IssueConsoleDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        let issue = try await client.issue(id: issueID)
        return Self.mapIssueDetail(issue)
    }

    public func loadAgentDetail(
        configuration: ServerConnectionConfiguration,
        agentID: String
    ) async throws -> AgentConsoleDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        let agent = try await client.agent(id: agentID)
        return Self.mapAgentDetail(agent)
    }

    public func addApprovalComment(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        body: String
    ) async throws -> ApprovalCommentEntry {
        let client = PaperclipAPIClient(configuration: configuration)
        let comment = try await client.addApprovalComment(id: approvalID, body: body)
        return Self.mapApprovalComment(comment)
    }

    public func performApprovalAction(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        action: ApprovalDecisionAction,
        note: String?
    ) async throws -> ApprovalDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        _ = try await client.performApprovalAction(id: approvalID, action: action, note: note)
        return try await loadApprovalDetail(configuration: configuration, approvalID: approvalID)
    }

    public func loadPluginConsoleSnapshot(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        logLimit: Int
    ) async throws -> PluginConsoleSnapshot {
        let client = PaperclipAPIClient(configuration: configuration)
        async let detailTask = client.plugin(id: pluginID)
        async let healthTask = client.pluginHealth(id: pluginID)
        async let logsTask = client.pluginLogs(id: pluginID, limit: logLimit)

        let detail = try await detailTask
        let health = try await healthTask
        let logs = try await logsTask

        return PluginConsoleSnapshot(
            detail: Self.mapPluginDetail(detail),
            health: Self.mapPluginHealth(health),
            logs: logs.map(Self.mapPluginLog)
        )
    }

    public func setPluginEnabled(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        isEnabled: Bool,
        reason: String?
    ) async throws -> PluginDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        let plugin = try await client.setPluginEnabled(id: pluginID, isEnabled: isEnabled, reason: reason)
        return Self.mapPluginDetail(plugin)
    }

    public func upgradePlugin(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        targetVersion: String?
    ) async throws -> PluginDetail {
        let client = PaperclipAPIClient(configuration: configuration)
        let plugin = try await client.upgradePlugin(id: pluginID, targetVersion: targetVersion)
        return Self.mapPluginDetail(plugin)
    }

    public func loadProjectWorkspaces(
        configuration: ServerConnectionConfiguration,
        projectID: String
    ) async throws -> [ProjectWorkspaceDetail] {
        let client = PaperclipAPIClient(configuration: configuration)
        let workspaces = try await client.projectWorkspaces(id: projectID)
        return workspaces.map(Self.mapWorkspace)
    }

    public func performWorkspaceRuntimeAction(
        configuration: ServerConnectionConfiguration,
        projectID: String,
        workspaceID: String,
        action: WorkspaceRuntimeAction
    ) async throws -> WorkspaceRuntimeActionResult {
        let client = PaperclipAPIClient(configuration: configuration)
        let response = try await client.performWorkspaceRuntimeAction(
            projectID: projectID,
            workspaceID: workspaceID,
            action: action
        )
        return Self.mapWorkspaceActionResult(response)
    }

    private static func mapHealth(_ dto: HealthDTO) -> ServerHealthSummary {
        ServerHealthSummary(
            status: dto.status,
            version: dto.version,
            deploymentMode: dto.deploymentMode,
            deploymentExposure: dto.deploymentExposure
        )
    }

    private static func mapApproval(_ dto: ApprovalDTO) -> ApprovalSummary {
        let owner = dto.payload["agentName"]?.stringValue
            ?? dto.payload["name"]?.stringValue
            ?? dto.payload["role"]?.stringValue
            ?? "Board"
        let priority = dto.payload["priority"]?.stringValue ?? dto.type.replacingOccurrences(of: "_", with: " ")
        return ApprovalSummary(
            id: dto.id,
            title: dto.payload["title"]?.stringValue ?? dto.payload["name"]?.stringValue ?? dto.type.replacingOccurrences(of: "_", with: " "),
            owner: owner,
            priorityLabel: priority.capitalized,
            createdAt: dto.createdAt
        )
    }

    private static func mapActivity(_ dto: ActivityDTO) -> ActivityFeedEntry {
        let actorLabel: String = {
            if let actorName = dto.details?["actorName"]?.stringValue, actorName.isEmpty == false {
                return actorName
            }
            if let agentName = dto.details?["agentName"]?.stringValue, agentName.isEmpty == false {
                return agentName
            }
            if dto.actorType == "system" {
                return "system"
            }
            return dto.actorId
        }()

        let entityLabel = dto.details?["title"]?.stringValue
            ?? dto.details?["name"]?.stringValue
            ?? "\(dto.entityType) \(dto.entityId)"

        return ActivityFeedEntry(
            id: dto.id,
            title: humanizeLabel(dto.action),
            actorLabel: actorLabel,
            entityLabel: entityLabel,
            detailSummary: dto.details.map(Self.describe(jsonObject:)),
            action: dto.action,
            entityType: dto.entityType,
            createdAt: dto.createdAt
        )
    }

    private static func mapApprovalDetail(
        _ dto: ApprovalDetailDTO,
        issues: [IssueDTO],
        comments: [ApprovalCommentDTO]
    ) -> ApprovalDetail {
        ApprovalDetail(
            id: dto.id,
            title: dto.payload["title"]?.stringValue
                ?? dto.payload["name"]?.stringValue
                ?? dto.type.replacingOccurrences(of: "_", with: " ").capitalized,
            owner: dto.payload["agentName"]?.stringValue
                ?? dto.payload["name"]?.stringValue
                ?? dto.requestedByAgentId
                ?? dto.requestedByUserId
                ?? "Board",
            type: dto.type,
            status: dto.status,
            requestedByAgentID: dto.requestedByAgentId,
            requestedByUserID: dto.requestedByUserId,
            decisionNote: dto.decisionNote,
            createdAt: dto.createdAt,
            updatedAt: dto.updatedAt,
            decidedAt: dto.decidedAt,
            payloadFields: dto.payload
                .map { ApprovalField(key: $0.key, value: Self.describe(jsonValue: $0.value)) }
                .sorted(by: { $0.key < $1.key }),
            linkedIssues: issues.map(Self.mapIssue),
            comments: comments.sorted(by: { $0.createdAt > $1.createdAt }).map(Self.mapApprovalComment)
        )
    }

    private static func mapApprovalComment(_ dto: ApprovalCommentDTO) -> ApprovalCommentEntry {
        ApprovalCommentEntry(
            id: dto.id,
            authorLabel: dto.authorAgentId ?? dto.authorUserId ?? "Board",
            body: dto.body,
            createdAt: dto.createdAt
        )
    }

    private static func mapIssueReference(_ dto: IssueReferenceDTO) -> IssueQueueSummary {
        IssueQueueSummary(
            id: dto.id,
            identifier: dto.identifier ?? dto.id,
            title: dto.title,
            status: dto.status,
            priority: dto.priority,
            assigneeLabel: dto.assigneeAgentId ?? dto.assigneeUserId ?? "Em fila operacional",
            updatedAt: .now
        )
    }

    private static func mapIssueDetail(_ dto: IssueDetailDTO) -> IssueConsoleDetail {
        let parentLabel = dto.ancestors?.last?.title
        let goalLabel = dto.goal?.title ?? dto.ancestors?.compactMap(\.goal?.title).last

        return IssueConsoleDetail(
            id: dto.id,
            identifier: dto.identifier ?? dto.id,
            title: dto.title,
            description: dto.description,
            status: dto.status,
            priority: dto.priority,
            assigneeLabel: dto.assigneeAgentId ?? dto.assigneeUserId ?? "Em fila operacional",
            projectLabel: dto.project?.name,
            goalLabel: goalLabel,
            parentLabel: parentLabel,
            blockedBy: (dto.blockedBy ?? []).map(Self.mapIssueReference),
            blocks: (dto.blocks ?? []).map(Self.mapIssueReference),
            createdAt: dto.createdAt,
            updatedAt: dto.updatedAt
        )
    }

    private static func mapAgentDetail(_ dto: AgentDetailDTO) -> AgentConsoleDetail {
        AgentConsoleDetail(
            id: dto.id,
            name: dto.name,
            role: dto.role,
            title: dto.title,
            status: dto.status,
            adapterType: dto.adapterType,
            budgetMonthlyCents: dto.budgetMonthlyCents,
            spentMonthlyCents: dto.spentMonthlyCents,
            pauseReason: dto.pauseReason,
            lastHeartbeatAt: dto.lastHeartbeatAt,
            canAssignTasks: dto.access.canAssignTasks,
            taskAssignSource: dto.access.taskAssignSource,
            chainOfCommand: dto.chainOfCommand.map {
                AgentChainEntry(id: $0.id, name: $0.name, role: $0.role, title: $0.title)
            }
        )
    }

    private static func mapIssue(_ dto: IssueDTO) -> IssueQueueSummary {
        IssueQueueSummary(
            id: dto.id,
            identifier: dto.identifier ?? dto.id,
            title: dto.title,
            status: dto.status,
            priority: dto.priority,
            assigneeLabel: "Em fila operacional",
            updatedAt: dto.updatedAt
        )
    }

    private static func mapGoal(_ dto: GoalDTO, agentNamesByID: [String: String]) -> GoalSummary {
        GoalSummary(
            id: dto.id,
            title: dto.title,
            description: dto.description,
            level: dto.level,
            status: dto.status,
            parentID: dto.parentId,
            ownerLabel: dto.ownerAgentId.flatMap { agentNamesByID[$0] } ?? dto.ownerAgentId ?? "Sem owner",
            createdAt: dto.createdAt,
            updatedAt: dto.updatedAt
        )
    }

    private static func mapProject(_ dto: ProjectDTO) -> ProjectSummary {
        ProjectSummary(
            id: dto.id,
            name: dto.name,
            status: dto.status,
            goalIDs: dto.goalIds,
            workspaceCount: dto.workspaces.count,
            goalCount: dto.goalIds.count,
            targetDateLabel: dto.targetDate ?? "Sem data"
        )
    }

    private static func mapPlugin(_ dto: PluginDTO) -> PluginSummary {
        PluginSummary(
            id: dto.id,
            displayName: dto.manifestJson?.displayName ?? dto.manifestJson?.name ?? dto.pluginKey,
            packageName: dto.packageName,
            version: dto.version,
            status: dto.status
        )
    }

    private static func mapPluginDetail(_ dto: PluginDetailDTO) -> PluginDetail {
        let displayName = dto.manifestJson?.displayName ?? dto.manifestJson?.name ?? dto.pluginKey
        let launcherCount = (dto.manifestJson?.launchers?.count ?? 0) + (dto.manifestJson?.ui?.launchers?.count ?? 0)
        let slotCount = dto.manifestJson?.ui?.slots?.count ?? 0
        return PluginDetail(
            id: dto.id,
            displayName: displayName,
            pluginKey: dto.pluginKey,
            packageName: dto.packageName,
            version: dto.version,
            status: dto.status,
            apiVersion: dto.apiVersion,
            installOrder: dto.installOrder,
            packagePath: dto.packagePath,
            supportsConfigTest: dto.supportsConfigTest ?? false,
            lastError: dto.lastError,
            categories: dto.manifestJson?.categories ?? [],
            launcherCount: launcherCount,
            slotCount: slotCount,
            installedAt: dto.installedAt,
            updatedAt: dto.updatedAt
        )
    }

    private static func mapPluginHealth(_ dto: PluginHealthDTO) -> PluginHealthSummary {
        PluginHealthSummary(
            status: dto.status,
            healthy: dto.healthy,
            checks: dto.checks.map { PluginHealthCheck(name: $0.name, passed: $0.passed, message: $0.message) },
            lastError: dto.lastError
        )
    }

    private static func mapPluginLog(_ dto: PluginLogDTO) -> PluginLogEntry {
        PluginLogEntry(
            id: dto.id,
            level: dto.level,
            message: dto.message,
            metaSummary: dto.meta.map(Self.describe(jsonObject:)),
            createdAt: dto.createdAt
        )
    }

    private static func mapWorkspace(_ dto: ProjectWorkspaceDetailDTO) -> ProjectWorkspaceDetail {
        let runtimeServices = (dto.runtimeServices ?? []).map {
            RuntimeServiceSummary(
                id: $0.id,
                serviceName: $0.serviceName,
                status: $0.status,
                lifecycle: $0.lifecycle,
                healthStatus: $0.healthStatus,
                port: $0.port,
                url: $0.url
            )
        }
        let desiredState = dto.runtimeConfig?.desiredState
            ?? (runtimeServices.contains(where: { $0.status == "running" }) ? "running" : "stopped")
        return ProjectWorkspaceDetail(
            id: dto.id,
            name: dto.name,
            sourceType: dto.sourceType,
            visibility: dto.visibility,
            cwd: dto.cwd,
            repoUrl: dto.repoUrl,
            repoRef: dto.repoRef,
            defaultRef: dto.defaultRef,
            desiredState: desiredState,
            isPrimary: dto.isPrimary,
            runtimeServices: runtimeServices,
            updatedAt: dto.updatedAt
        )
    }

    private static func mapWorkspaceActionResult(_ dto: WorkspaceRuntimeActionResponseDTO) -> WorkspaceRuntimeActionResult {
        let runtimeServiceCount = dto.operation.metadata?["runtimeServiceCount"]?.intValue ?? dto.workspace.runtimeServices?.count ?? 0
        let parts = [dto.operation.system, dto.operation.stdout, dto.operation.stderr]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
        return WorkspaceRuntimeActionResult(
            workspace: mapWorkspace(dto.workspace),
            operationStatus: dto.operation.status,
            outputSummary: parts.joined(separator: "\n\n"),
            runtimeServiceCount: runtimeServiceCount
        )
    }

    private static func buildSignals(
        health: HealthDTO,
        dashboard: DashboardDTO,
        approvals: [ApprovalDTO],
        issueCount: Int
    ) -> [OperationsSignal] {
        var signals = [
            OperationsSignal(
                title: "Servidor \(health.status)",
                detail: "Versão \(health.version) em modo \(health.deploymentMode ?? "unknown")/\(health.deploymentExposure ?? "unknown").",
                occurredAt: .now
            ),
            OperationsSignal(
                title: "Fila operacional",
                detail: "\(issueCount) issues abertas, \(dashboard.tasks.inProgress) em andamento e \(dashboard.tasks.blocked) bloqueadas.",
                occurredAt: .now
            ),
        ]

        if dashboard.budgets.activeIncidents > 0 {
            signals.append(
                OperationsSignal(
                    title: "Budget requer atenção",
                    detail: "\(dashboard.budgets.activeIncidents) incidentes ativos de orçamento no momento.",
                    occurredAt: .now
                )
            )
        }

        if approvals.isEmpty == false {
            signals.append(
                OperationsSignal(
                    title: "Aprovações pendentes",
                    detail: "\(approvals.count) decisões aguardando o board.",
                    occurredAt: .now
                )
            )
        }

        return signals
    }

    private static func formatCurrency(cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "BRL"
        formatter.locale = Locale(identifier: "pt_BR")
        let value = NSNumber(value: Double(cents) / 100.0)
        return formatter.string(from: value) ?? "R$ 0,00"
    }

    private static func describe(jsonObject: [String: JSONValue]) -> String {
        jsonObject
            .sorted(by: { $0.key < $1.key })
            .map { "\($0.key): \(describe(jsonValue: $0.value))" }
            .joined(separator: ", ")
    }

    private static func describe(jsonValue: JSONValue) -> String {
        switch jsonValue {
        case let .string(value):
            return value
        case let .number(value):
            return value.rounded() == value ? String(Int(value)) : String(value)
        case let .bool(value):
            return value ? "true" : "false"
        case let .object(object):
            return describe(jsonObject: object)
        case let .array(values):
            return values.map(describe(jsonValue:)).joined(separator: ", ")
        case .null:
            return "null"
        }
    }

    private static func humanizeLabel(_ value: String) -> String {
        value
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { segment in
                let lowercased = segment.lowercased()
                return lowercased.prefix(1).uppercased() + lowercased.dropFirst()
            }
            .joined(separator: " ")
    }
}

private enum JSONValue: Decodable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    var stringValue: String? {
        switch self {
        case let .string(value): value
        case let .number(value): String(value)
        case let .bool(value): value ? "true" : "false"
        default: nil
        }
    }

    var intValue: Int? {
        switch self {
        case let .number(value):
            Int(value)
        case let .string(value):
            Int(value)
        default:
            nil
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }
}
