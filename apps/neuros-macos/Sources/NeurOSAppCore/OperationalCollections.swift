import Foundation

public struct DashboardSummary: Sendable {
    public var openTasks: Int
    public var inProgressTasks: Int
    public var blockedTasks: Int
    public var doneTasks: Int
    public var activeAgents: Int
    public var runningAgents: Int
    public var pausedAgents: Int
    public var erroredAgents: Int
    public var pendingApprovals: Int
    public var monthSpendCents: Int
    public var monthBudgetCents: Int
    public var monthUtilizationPercent: Double
    public var activeBudgetIncidents: Int
    public var pausedProjects: Int

    public init(
        openTasks: Int,
        inProgressTasks: Int,
        blockedTasks: Int,
        doneTasks: Int,
        activeAgents: Int,
        runningAgents: Int,
        pausedAgents: Int,
        erroredAgents: Int,
        pendingApprovals: Int,
        monthSpendCents: Int,
        monthBudgetCents: Int,
        monthUtilizationPercent: Double,
        activeBudgetIncidents: Int,
        pausedProjects: Int
    ) {
        self.openTasks = openTasks
        self.inProgressTasks = inProgressTasks
        self.blockedTasks = blockedTasks
        self.doneTasks = doneTasks
        self.activeAgents = activeAgents
        self.runningAgents = runningAgents
        self.pausedAgents = pausedAgents
        self.erroredAgents = erroredAgents
        self.pendingApprovals = pendingApprovals
        self.monthSpendCents = monthSpendCents
        self.monthBudgetCents = monthBudgetCents
        self.monthUtilizationPercent = monthUtilizationPercent
        self.activeBudgetIncidents = activeBudgetIncidents
        self.pausedProjects = pausedProjects
    }
}

public struct IssueQueueSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var identifier: String
    public var title: String
    public var status: String
    public var priority: String
    public var assigneeLabel: String
    public var updatedAt: Date

    public init(
        id: String,
        identifier: String,
        title: String,
        status: String,
        priority: String,
        assigneeLabel: String,
        updatedAt: Date
    ) {
        self.id = id
        self.identifier = identifier
        self.title = title
        self.status = status
        self.priority = priority
        self.assigneeLabel = assigneeLabel
        self.updatedAt = updatedAt
    }
}

public struct ProjectSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var status: String
    public var goalIDs: [String]
    public var workspaceCount: Int
    public var goalCount: Int
    public var targetDateLabel: String

    public init(
        id: String,
        name: String,
        status: String,
        goalIDs: [String],
        workspaceCount: Int,
        goalCount: Int,
        targetDateLabel: String
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.goalIDs = goalIDs
        self.workspaceCount = workspaceCount
        self.goalCount = goalCount
        self.targetDateLabel = targetDateLabel
    }
}

public struct GoalSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var title: String
    public var description: String?
    public var level: String
    public var status: String
    public var parentID: String?
    public var ownerLabel: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        title: String,
        description: String?,
        level: String,
        status: String,
        parentID: String?,
        ownerLabel: String,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.level = level
        self.status = status
        self.parentID = parentID
        self.ownerLabel = ownerLabel
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct PluginSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var displayName: String
    public var packageName: String
    public var version: String
    public var status: String

    public init(
        id: String,
        displayName: String,
        packageName: String,
        version: String,
        status: String
    ) {
        self.id = id
        self.displayName = displayName
        self.packageName = packageName
        self.version = version
        self.status = status
    }
}

public struct OperationsSnapshot: Sendable {
    public var companies: [CompanySummary]
    public var selectedCompanyID: String?
    public var dashboard: DashboardSummary?
    public var approvals: [ApprovalSummary]
    public var activity: [ActivityFeedEntry]
    public var signals: [OperationsSignal]
    public var agents: [AgentRuntimeSummary]
    public var issues: [IssueQueueSummary]
    public var goals: [GoalSummary]
    public var projects: [ProjectSummary]
    public var plugins: [PluginSummary]
    public var health: ServerHealthSummary?

    public init(
        companies: [CompanySummary],
        selectedCompanyID: String?,
        dashboard: DashboardSummary?,
        approvals: [ApprovalSummary],
        activity: [ActivityFeedEntry],
        signals: [OperationsSignal],
        agents: [AgentRuntimeSummary],
        issues: [IssueQueueSummary],
        goals: [GoalSummary],
        projects: [ProjectSummary],
        plugins: [PluginSummary],
        health: ServerHealthSummary?
    ) {
        self.companies = companies
        self.selectedCompanyID = selectedCompanyID
        self.dashboard = dashboard
        self.approvals = approvals
        self.activity = activity
        self.signals = signals
        self.agents = agents
        self.issues = issues
        self.goals = goals
        self.projects = projects
        self.plugins = plugins
        self.health = health
    }
}
