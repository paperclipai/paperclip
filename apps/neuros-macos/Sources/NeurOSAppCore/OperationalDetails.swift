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
