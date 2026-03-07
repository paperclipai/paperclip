import SwiftUI
import Foundation

// MARK: - Agent Type

enum AgentType: String, Codable, CaseIterable, Identifiable {
    case primary = "Primary"
    case subAgent = "Sub-Agent"

    var id: String { rawValue }

    var iconName: String {
        switch self {
        case .primary: return "cpu"
        case .subAgent: return "arrow.triangle.branch"
        }
    }

    var color: Color {
        switch self {
        case .primary: return .blue
        case .subAgent: return .purple
        }
    }
}

// MARK: - Agent Status

enum AgentStatus: String, Codable, CaseIterable {
    case idle = "Idle"
    case running = "Running"
    case error = "Error"
    case stopped = "Stopped"

    var color: Color {
        switch self {
        case .idle: return .secondary
        case .running: return .green
        case .error: return .red
        case .stopped: return .orange
        }
    }

    var iconName: String {
        switch self {
        case .idle: return "pause.circle"
        case .running: return "play.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        case .stopped: return "stop.circle"
        }
    }
}

// MARK: - Agent Model

struct Agent: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var description: String
    var agentType: AgentType
    var parentAgentId: UUID?
    var status: AgentStatus
    var model: String
    var systemPrompt: String
    var mcpServers: [MCPServer]
    var environment: [String: String]
    var maxTokens: Int
    var temperature: Double
    var canisterId: String?
    var subAgentIds: [UUID]
    let createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        name: String,
        description: String = "",
        agentType: AgentType = .primary,
        parentAgentId: UUID? = nil,
        status: AgentStatus = .idle,
        model: String = "claude-opus-4-6",
        systemPrompt: String = "",
        mcpServers: [MCPServer] = [],
        environment: [String: String] = [:],
        maxTokens: Int = 8096,
        temperature: Double = 1.0,
        canisterId: String? = nil,
        subAgentIds: [UUID] = []
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.agentType = agentType
        self.parentAgentId = parentAgentId
        self.status = status
        self.model = model
        self.systemPrompt = systemPrompt
        self.mcpServers = mcpServers
        self.environment = environment
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.canisterId = canisterId
        self.subAgentIds = subAgentIds
        self.createdAt = Date()
        self.updatedAt = Date()
    }

    /// Returns a short display summary of the agent config
    var configSummary: String {
        var parts: [String] = [model]
        if !mcpServers.isEmpty {
            parts.append("\(mcpServers.count) MCP server\(mcpServers.count == 1 ? "" : "s")")
        }
        if !subAgentIds.isEmpty {
            parts.append("\(subAgentIds.count) sub-agent\(subAgentIds.count == 1 ? "" : "s")")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Known Models

enum KnownModel: String, CaseIterable {
    case claudeOpus = "claude-opus-4-6"
    case claudeSonnet = "claude-sonnet-4-6"
    case claudeHaiku = "claude-haiku-4-6"
    case claudeOpus3 = "claude-3-opus-20240229"
    case claudeSonnet35 = "claude-3-5-sonnet-20241022"
    case gpt4o = "gpt-4o"
    case gpt4oMini = "gpt-4o-mini"
    case gemini15Pro = "gemini-1.5-pro"

    var displayName: String { rawValue }

    static var allDisplayNames: [String] {
        allCases.map(\.rawValue)
    }
}
