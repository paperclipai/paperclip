import Foundation

public struct ApprovalField: Identifiable, Hashable, Sendable {
    public let id: String
    public var key: String
    public var value: String

    public init(key: String, value: String) {
        self.id = key
        self.key = key
        self.value = value
    }
}

public struct IssueConsoleDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var identifier: String
    public var title: String
    public var description: String?
    public var status: String
    public var priority: String
    public var assigneeLabel: String
    public var projectLabel: String?
    public var goalLabel: String?
    public var parentLabel: String?
    public var blockedBy: [IssueQueueSummary]
    public var blocks: [IssueQueueSummary]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        identifier: String,
        title: String,
        description: String?,
        status: String,
        priority: String,
        assigneeLabel: String,
        projectLabel: String?,
        goalLabel: String?,
        parentLabel: String?,
        blockedBy: [IssueQueueSummary],
        blocks: [IssueQueueSummary],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.identifier = identifier
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.assigneeLabel = assigneeLabel
        self.projectLabel = projectLabel
        self.goalLabel = goalLabel
        self.parentLabel = parentLabel
        self.blockedBy = blockedBy
        self.blocks = blocks
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct AgentChainEntry: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var role: String
    public var title: String?

    public init(id: String, name: String, role: String, title: String?) {
        self.id = id
        self.name = name
        self.role = role
        self.title = title
    }
}

public struct AgentConsoleDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var role: String
    public var title: String?
    public var status: String
    public var adapterType: String
    public var budgetMonthlyCents: Int
    public var spentMonthlyCents: Int
    public var pauseReason: String?
    public var lastHeartbeatAt: Date?
    public var canAssignTasks: Bool
    public var taskAssignSource: String
    public var chainOfCommand: [AgentChainEntry]

    public init(
        id: String,
        name: String,
        role: String,
        title: String?,
        status: String,
        adapterType: String,
        budgetMonthlyCents: Int,
        spentMonthlyCents: Int,
        pauseReason: String?,
        lastHeartbeatAt: Date?,
        canAssignTasks: Bool,
        taskAssignSource: String,
        chainOfCommand: [AgentChainEntry]
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.title = title
        self.status = status
        self.adapterType = adapterType
        self.budgetMonthlyCents = budgetMonthlyCents
        self.spentMonthlyCents = spentMonthlyCents
        self.pauseReason = pauseReason
        self.lastHeartbeatAt = lastHeartbeatAt
        self.canAssignTasks = canAssignTasks
        self.taskAssignSource = taskAssignSource
        self.chainOfCommand = chainOfCommand
    }
}

public struct ApprovalCommentEntry: Identifiable, Hashable, Sendable {
    public let id: String
    public var authorLabel: String
    public var body: String
    public var createdAt: Date

    public init(id: String, authorLabel: String, body: String, createdAt: Date) {
        self.id = id
        self.authorLabel = authorLabel
        self.body = body
        self.createdAt = createdAt
    }
}

public struct ApprovalDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var title: String
    public var owner: String
    public var type: String
    public var status: String
    public var requestedByAgentID: String?
    public var requestedByUserID: String?
    public var decisionNote: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var decidedAt: Date?
    public var payloadFields: [ApprovalField]
    public var linkedIssues: [IssueQueueSummary]
    public var comments: [ApprovalCommentEntry]

    public init(
        id: String,
        title: String,
        owner: String,
        type: String,
        status: String,
        requestedByAgentID: String?,
        requestedByUserID: String?,
        decisionNote: String?,
        createdAt: Date,
        updatedAt: Date,
        decidedAt: Date?,
        payloadFields: [ApprovalField],
        linkedIssues: [IssueQueueSummary],
        comments: [ApprovalCommentEntry]
    ) {
        self.id = id
        self.title = title
        self.owner = owner
        self.type = type
        self.status = status
        self.requestedByAgentID = requestedByAgentID
        self.requestedByUserID = requestedByUserID
        self.decisionNote = decisionNote
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.decidedAt = decidedAt
        self.payloadFields = payloadFields
        self.linkedIssues = linkedIssues
        self.comments = comments
    }
}

public enum ApprovalDecisionAction: String, CaseIterable, Identifiable, Sendable {
    case approve
    case reject
    case requestRevision = "request-revision"
    case resubmit

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .approve: "Aprovar"
        case .reject: "Rejeitar"
        case .requestRevision: "Pedir revisão"
        case .resubmit: "Reenviar"
        }
    }
}

public struct PluginHealthCheck: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var passed: Bool
    public var message: String?

    public init(name: String, passed: Bool, message: String?) {
        self.id = name
        self.name = name
        self.passed = passed
        self.message = message
    }
}

public struct PluginHealthSummary: Sendable, Hashable {
    public var status: String
    public var healthy: Bool
    public var checks: [PluginHealthCheck]
    public var lastError: String?

    public init(status: String, healthy: Bool, checks: [PluginHealthCheck], lastError: String?) {
        self.status = status
        self.healthy = healthy
        self.checks = checks
        self.lastError = lastError
    }
}

public struct PluginLogEntry: Identifiable, Hashable, Sendable {
    public let id: String
    public var level: String
    public var message: String
    public var metaSummary: String?
    public var createdAt: Date

    public init(id: String, level: String, message: String, metaSummary: String?, createdAt: Date) {
        self.id = id
        self.level = level
        self.message = message
        self.metaSummary = metaSummary
        self.createdAt = createdAt
    }
}

public struct PluginDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var displayName: String
    public var pluginKey: String
    public var packageName: String
    public var version: String
    public var status: String
    public var apiVersion: Int
    public var installOrder: Int?
    public var packagePath: String?
    public var supportsConfigTest: Bool
    public var lastError: String?
    public var categories: [String]
    public var launcherCount: Int
    public var slotCount: Int
    public var installedAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        displayName: String,
        pluginKey: String,
        packageName: String,
        version: String,
        status: String,
        apiVersion: Int,
        installOrder: Int?,
        packagePath: String?,
        supportsConfigTest: Bool,
        lastError: String?,
        categories: [String],
        launcherCount: Int,
        slotCount: Int,
        installedAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.displayName = displayName
        self.pluginKey = pluginKey
        self.packageName = packageName
        self.version = version
        self.status = status
        self.apiVersion = apiVersion
        self.installOrder = installOrder
        self.packagePath = packagePath
        self.supportsConfigTest = supportsConfigTest
        self.lastError = lastError
        self.categories = categories
        self.launcherCount = launcherCount
        self.slotCount = slotCount
        self.installedAt = installedAt
        self.updatedAt = updatedAt
    }
}

public struct PluginConsoleSnapshot: Sendable, Hashable {
    public var detail: PluginDetail
    public var health: PluginHealthSummary
    public var logs: [PluginLogEntry]

    public init(detail: PluginDetail, health: PluginHealthSummary, logs: [PluginLogEntry]) {
        self.detail = detail
        self.health = health
        self.logs = logs
    }
}

public struct RuntimeServiceSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var serviceName: String
    public var status: String
    public var lifecycle: String
    public var healthStatus: String
    public var port: Int?
    public var url: String?

    public init(
        id: String,
        serviceName: String,
        status: String,
        lifecycle: String,
        healthStatus: String,
        port: Int?,
        url: String?
    ) {
        self.id = id
        self.serviceName = serviceName
        self.status = status
        self.lifecycle = lifecycle
        self.healthStatus = healthStatus
        self.port = port
        self.url = url
    }
}

public struct ProjectWorkspaceDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var sourceType: String
    public var visibility: String
    public var cwd: String?
    public var repoUrl: String?
    public var repoRef: String?
    public var defaultRef: String?
    public var desiredState: String
    public var isPrimary: Bool
    public var runtimeServices: [RuntimeServiceSummary]
    public var updatedAt: Date

    public init(
        id: String,
        name: String,
        sourceType: String,
        visibility: String,
        cwd: String?,
        repoUrl: String?,
        repoRef: String?,
        defaultRef: String?,
        desiredState: String,
        isPrimary: Bool,
        runtimeServices: [RuntimeServiceSummary],
        updatedAt: Date
    ) {
        self.id = id
        self.name = name
        self.sourceType = sourceType
        self.visibility = visibility
        self.cwd = cwd
        self.repoUrl = repoUrl
        self.repoRef = repoRef
        self.defaultRef = defaultRef
        self.desiredState = desiredState
        self.isPrimary = isPrimary
        self.runtimeServices = runtimeServices
        self.updatedAt = updatedAt
    }
}

public enum WorkspaceRuntimeAction: String, CaseIterable, Identifiable, Sendable {
    case start
    case stop
    case restart

    public var id: String { rawValue }

    public var label: String { rawValue.capitalized }
}

public struct WorkspaceRuntimeActionResult: Sendable, Hashable {
    public var workspace: ProjectWorkspaceDetail
    public var operationStatus: String
    public var outputSummary: String
    public var runtimeServiceCount: Int

    public init(
        workspace: ProjectWorkspaceDetail,
        operationStatus: String,
        outputSummary: String,
        runtimeServiceCount: Int
    ) {
        self.workspace = workspace
        self.operationStatus = operationStatus
        self.outputSummary = outputSummary
        self.runtimeServiceCount = runtimeServiceCount
    }
}

// MARK: - Routines

public struct RoutineSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var title: String
    public var status: String
    public var priority: String
    public var assigneeLabel: String
    public var projectLabel: String?
    public var triggerCount: Int
    public var enabledTriggerCount: Int
    public var lastRunStatus: String?
    public var lastRunAt: Date?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String, title: String, status: String, priority: String,
                assigneeLabel: String, projectLabel: String?, triggerCount: Int,
                enabledTriggerCount: Int, lastRunStatus: String?, lastRunAt: Date?,
                createdAt: Date, updatedAt: Date) {
        self.id = id; self.title = title; self.status = status; self.priority = priority
        self.assigneeLabel = assigneeLabel; self.projectLabel = projectLabel
        self.triggerCount = triggerCount; self.enabledTriggerCount = enabledTriggerCount
        self.lastRunStatus = lastRunStatus; self.lastRunAt = lastRunAt
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

public struct RoutineTriggerSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var kind: String
    public var label: String?
    public var enabled: Bool
    public var nextRunAt: Date?
    public var lastFiredAt: Date?
    public var lastResult: String?

    public init(id: String, kind: String, label: String?, enabled: Bool,
                nextRunAt: Date?, lastFiredAt: Date?, lastResult: String?) {
        self.id = id; self.kind = kind; self.label = label; self.enabled = enabled
        self.nextRunAt = nextRunAt; self.lastFiredAt = lastFiredAt; self.lastResult = lastResult
    }
}

public struct RoutineRunSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var status: String
    public var source: String
    public var triggeredAt: Date
    public var completedAt: Date?
    public var failureReason: String?
    public var linkedIssueIdentifier: String?
    public var triggerKind: String?
    public var triggerLabel: String?

    public init(id: String, status: String, source: String, triggeredAt: Date,
                completedAt: Date?, failureReason: String?, linkedIssueIdentifier: String?,
                triggerKind: String?, triggerLabel: String?) {
        self.id = id; self.status = status; self.source = source; self.triggeredAt = triggeredAt
        self.completedAt = completedAt; self.failureReason = failureReason
        self.linkedIssueIdentifier = linkedIssueIdentifier; self.triggerKind = triggerKind
        self.triggerLabel = triggerLabel
    }
}

public struct RoutineDetail: Identifiable, Sendable {
    public let id: String
    public var title: String
    public var description: String?
    public var status: String
    public var priority: String
    public var concurrencyPolicy: String
    public var catchUpPolicy: String
    public var assigneeLabel: String
    public var projectLabel: String?
    public var parentIssueTitle: String?
    public var activeIssueTitle: String?
    public var triggers: [RoutineTriggerSummary]
    public var recentRuns: [RoutineRunSummary]
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String, title: String, description: String?, status: String,
                priority: String, concurrencyPolicy: String, catchUpPolicy: String,
                assigneeLabel: String, projectLabel: String?, parentIssueTitle: String?,
                activeIssueTitle: String?, triggers: [RoutineTriggerSummary],
                recentRuns: [RoutineRunSummary], createdAt: Date, updatedAt: Date) {
        self.id = id; self.title = title; self.description = description
        self.status = status; self.priority = priority
        self.concurrencyPolicy = concurrencyPolicy; self.catchUpPolicy = catchUpPolicy
        self.assigneeLabel = assigneeLabel; self.projectLabel = projectLabel
        self.parentIssueTitle = parentIssueTitle; self.activeIssueTitle = activeIssueTitle
        self.triggers = triggers; self.recentRuns = recentRuns
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

// MARK: - Costs

public struct CostSummarySnapshot: Sendable, Hashable {
    public var totalCostCents: Int
    public var eventCount: Int
    public var agentCount: Int
    public var modelCount: Int
    public var providerCount: Int

    public init(totalCostCents: Int, eventCount: Int, agentCount: Int,
                modelCount: Int, providerCount: Int) {
        self.totalCostCents = totalCostCents; self.eventCount = eventCount
        self.agentCount = agentCount; self.modelCount = modelCount
        self.providerCount = providerCount
    }
}

public struct CostBreakdownEntry: Identifiable, Hashable, Sendable {
    public let id: String
    public var label: String
    public var costCents: Int
    public var eventCount: Int

    public init(id: String, label: String, costCents: Int, eventCount: Int) {
        self.id = id; self.label = label; self.costCents = costCents; self.eventCount = eventCount
    }
}

// MARK: - Adapters

public struct AdapterSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var type: String
    public var source: String
    public var loaded: Bool
    public var disabled: Bool
    public var modelsCount: Int
    public var version: String?
    public var packageName: String?

    public init(id: String, type: String, source: String, loaded: Bool,
                disabled: Bool, modelsCount: Int, version: String?, packageName: String?) {
        self.id = id; self.type = type; self.source = source
        self.loaded = loaded; self.disabled = disabled; self.modelsCount = modelsCount
        self.version = version; self.packageName = packageName
    }
}

// MARK: - Company Skills

public struct CompanySkillSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var description: String?
    public var status: String
    public var kind: String?
    public var agentCount: Int
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String, name: String, description: String?, status: String,
                kind: String?, agentCount: Int, createdAt: Date, updatedAt: Date) {
        self.id = id; self.name = name; self.description = description
        self.status = status; self.kind = kind; self.agentCount = agentCount
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

// MARK: - Org Chart

public struct OrgNode: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var role: String
    public var title: String?
    public var status: String
    public var adapterType: String
    public var reportsToId: String?
    public var childIDs: [String]
    public var depth: Int

    public init(id: String, name: String, role: String, title: String?, status: String,
                adapterType: String, reportsToId: String?, childIDs: [String], depth: Int) {
        self.id = id; self.name = name; self.role = role; self.title = title
        self.status = status; self.adapterType = adapterType
        self.reportsToId = reportsToId; self.childIDs = childIDs; self.depth = depth
    }
}

// MARK: - Company Settings

public struct CompanySettingsDetail: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var description: String?
    public var status: String
    public var issuePrefix: String
    public var budgetMonthlyCents: Int
    public var spentMonthlyCents: Int
    public var requireBoardApprovalForNewAgents: Bool
    public var feedbackDataSharingEnabled: Bool
    public var brandColor: String?
    public var logoURL: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        name: String,
        description: String?,
        status: String,
        issuePrefix: String,
        budgetMonthlyCents: Int,
        spentMonthlyCents: Int,
        requireBoardApprovalForNewAgents: Bool,
        feedbackDataSharingEnabled: Bool,
        brandColor: String?,
        logoURL: String?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.status = status
        self.issuePrefix = issuePrefix
        self.budgetMonthlyCents = budgetMonthlyCents
        self.spentMonthlyCents = spentMonthlyCents
        self.requireBoardApprovalForNewAgents = requireBoardApprovalForNewAgents
        self.feedbackDataSharingEnabled = feedbackDataSharingEnabled
        self.brandColor = brandColor
        self.logoURL = logoURL
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct CompanySettingsDraft: Hashable, Sendable {
    public var name: String
    public var description: String
    public var status: String
    public var budgetMonthlyCents: Int
    public var requireBoardApprovalForNewAgents: Bool
    public var feedbackDataSharingEnabled: Bool
    public var brandColor: String

    public init(
        name: String = "",
        description: String = "",
        status: String = "active",
        budgetMonthlyCents: Int = 0,
        requireBoardApprovalForNewAgents: Bool = false,
        feedbackDataSharingEnabled: Bool = false,
        brandColor: String = ""
    ) {
        self.name = name
        self.description = description
        self.status = status
        self.budgetMonthlyCents = budgetMonthlyCents
        self.requireBoardApprovalForNewAgents = requireBoardApprovalForNewAgents
        self.feedbackDataSharingEnabled = feedbackDataSharingEnabled
        self.brandColor = brandColor
    }

    public init(detail: CompanySettingsDetail) {
        self.init(
            name: detail.name,
            description: detail.description ?? "",
            status: detail.status,
            budgetMonthlyCents: detail.budgetMonthlyCents,
            requireBoardApprovalForNewAgents: detail.requireBoardApprovalForNewAgents,
            feedbackDataSharingEnabled: detail.feedbackDataSharingEnabled,
            brandColor: detail.brandColor ?? ""
        )
    }
}
