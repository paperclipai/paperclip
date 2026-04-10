import Foundation

public enum RuntimeMode: String, Sendable {
    case hybrid
    case local
    case remote
}

public enum ConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case local(nodeName: String)
    case remote(hostname: String)
    case degraded(message: String)

    public var label: String {
        switch self {
        case .disconnected: "Desconectado"
        case .connecting: "Conectando"
        case let .local(nodeName): "Local em \(nodeName)"
        case let .remote(hostname): "Remoto em \(hostname)"
        case .degraded: "Requer atenção"
        }
    }
}

public struct CompanySummary: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var projectsCount: Int
    public var activeIssuesCount: Int
    public var activeAgentsCount: Int
    public var recentSignalsCount: Int

    public init(
        id: UUID = UUID(),
        name: String,
        projectsCount: Int,
        activeIssuesCount: Int,
        activeAgentsCount: Int,
        recentSignalsCount: Int
    ) {
        self.id = id
        self.name = name
        self.projectsCount = projectsCount
        self.activeIssuesCount = activeIssuesCount
        self.activeAgentsCount = activeAgentsCount
        self.recentSignalsCount = recentSignalsCount
    }
}

public struct OperationsSignal: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var title: String
    public var detail: String
    public var occurredAt: Date

    public init(id: UUID = UUID(), title: String, detail: String, occurredAt: Date) {
        self.id = id
        self.title = title
        self.detail = detail
        self.occurredAt = occurredAt
    }
}

public struct ApprovalSummary: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var title: String
    public var owner: String
    public var priorityLabel: String

    public init(id: UUID = UUID(), title: String, owner: String, priorityLabel: String) {
        self.id = id
        self.title = title
        self.owner = owner
        self.priorityLabel = priorityLabel
    }
}

public struct AgentRuntimeSummary: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var role: String
    public var stateLabel: String
    public var issueLabel: String

    public init(
        id: UUID = UUID(),
        name: String,
        role: String,
        stateLabel: String,
        issueLabel: String
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.stateLabel = stateLabel
        self.issueLabel = issueLabel
    }
}

public struct OperationsSnapshot: Sendable {
    public var companies: [CompanySummary]
    public var approvals: [ApprovalSummary]
    public var signals: [OperationsSignal]
    public var agents: [AgentRuntimeSummary]

    public init(
        companies: [CompanySummary],
        approvals: [ApprovalSummary],
        signals: [OperationsSignal],
        agents: [AgentRuntimeSummary]
    ) {
        self.companies = companies
        self.approvals = approvals
        self.signals = signals
        self.agents = agents
    }
}
