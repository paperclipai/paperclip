import SwiftUI
import Combine
import Foundation

/// Central store and single source of truth for all agent data
@MainActor
final class AgentStore: ObservableObject {

    // MARK: - Published State

    @Published var agents: [Agent] = []
    @Published var sessions: [ChatSession] = []
    @Published var selectedAgentId: UUID?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    // MARK: - Persistence Keys

    private let agentsKey = "agentvault.agents"
    private let sessionsKey = "agentvault.chat_sessions"

    // MARK: - Init

    init() {
        loadAgents()
        loadSessions()
    }

    // MARK: - Computed Properties

    var selectedAgent: Agent? {
        agents.first { $0.id == selectedAgentId }
    }

    var primaryAgents: [Agent] {
        agents.filter { $0.agentType == .primary }
    }

    func subAgents(of agent: Agent) -> [Agent] {
        agents.filter { $0.parentAgentId == agent.id }
    }

    func sessions(for agentId: UUID) -> [ChatSession] {
        sessions.filter { $0.agentId == agentId }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Agent CRUD

    func createAgent(
        name: String,
        description: String = "",
        agentType: AgentType = .primary,
        parentAgentId: UUID? = nil,
        model: String = "claude-opus-4-6",
        systemPrompt: String = ""
    ) -> Agent {
        let agent = Agent(
            name: name,
            description: description,
            agentType: agentType,
            parentAgentId: parentAgentId,
            model: model,
            systemPrompt: systemPrompt
        )
        agents.append(agent)

        // Link to parent if this is a sub-agent
        if let parentId = parentAgentId,
           let idx = agents.firstIndex(where: { $0.id == parentId }) {
            agents[idx].subAgentIds.append(agent.id)
            agents[idx].updatedAt = Date()
        }

        saveAgents()
        return agent
    }

    func updateAgent(_ agent: Agent) {
        if let idx = agents.firstIndex(where: { $0.id == agent.id }) {
            var updated = agent
            updated.updatedAt = Date()
            agents[idx] = updated
            saveAgents()
        }
    }

    func deleteAgent(_ agent: Agent) {
        // Remove from parent's subAgentIds
        if let parentId = agent.parentAgentId,
           let idx = agents.firstIndex(where: { $0.id == parentId }) {
            agents[idx].subAgentIds.removeAll { $0 == agent.id }
        }

        // Recursively delete sub-agents
        for subId in agent.subAgentIds {
            if let sub = agents.first(where: { $0.id == subId }) {
                deleteAgent(sub)
            }
        }

        // Remove agent and its sessions
        agents.removeAll { $0.id == agent.id }
        sessions.removeAll { $0.agentId == agent.id }

        if selectedAgentId == agent.id {
            selectedAgentId = agents.first?.id
        }

        saveAgents()
        saveSessions()
    }

    func addMCPServer(_ server: MCPServer, to agentId: UUID) {
        if let idx = agents.firstIndex(where: { $0.id == agentId }) {
            agents[idx].mcpServers.append(server)
            agents[idx].updatedAt = Date()
            saveAgents()
        }
    }

    func removeMCPServer(_ server: MCPServer, from agentId: UUID) {
        if let idx = agents.firstIndex(where: { $0.id == agentId }) {
            agents[idx].mcpServers.removeAll { $0.id == server.id }
            agents[idx].updatedAt = Date()
            saveAgents()
        }
    }

    func updateMCPServer(_ server: MCPServer, in agentId: UUID) {
        if let agentIdx = agents.firstIndex(where: { $0.id == agentId }),
           let serverIdx = agents[agentIdx].mcpServers.firstIndex(where: { $0.id == server.id }) {
            agents[agentIdx].mcpServers[serverIdx] = server
            agents[agentIdx].updatedAt = Date()
            saveAgents()
        }
    }

    // MARK: - Chat Session Management

    func createSession(for agentId: UUID) -> ChatSession {
        let session = ChatSession(agentId: agentId)
        sessions.append(session)
        saveSessions()
        return session
    }

    func updateSession(_ session: ChatSession) {
        if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[idx] = session
            saveSessions()
        }
    }

    func deleteSession(_ session: ChatSession) {
        sessions.removeAll { $0.id == session.id }
        saveSessions()
    }

    func appendMessage(_ message: ChatMessage, to sessionId: UUID) {
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].messages.append(message)
            sessions[idx].updatedAt = Date()
            if sessions[idx].messages.filter({ $0.role == .user }).count == 1 {
                sessions[idx].generateTitle()
            }
            saveSessions()
        }
    }

    func updateLastMessage(_ content: String, in sessionId: UUID) {
        if let sIdx = sessions.firstIndex(where: { $0.id == sessionId }),
           let mIdx = sessions[sIdx].messages.indices.last {
            sessions[sIdx].messages[mIdx].content = content
            sessions[sIdx].messages[mIdx].isStreaming = false
            sessions[sIdx].updatedAt = Date()
            saveSessions()
        }
    }

    // MARK: - Persistence

    func loadAgents() {
        guard let data = UserDefaults.standard.data(forKey: agentsKey) else { return }
        if let decoded = try? JSONDecoder().decode([Agent].self, from: data) {
            agents = decoded
        }
    }

    func saveAgents() {
        if let encoded = try? JSONEncoder().encode(agents) {
            UserDefaults.standard.set(encoded, forKey: agentsKey)
        }
    }

    func loadSessions() {
        guard let data = UserDefaults.standard.data(forKey: sessionsKey) else { return }
        if let decoded = try? JSONDecoder().decode([ChatSession].self, from: data) {
            sessions = decoded
        }
    }

    func saveSessions() {
        if let encoded = try? JSONEncoder().encode(sessions) {
            UserDefaults.standard.set(encoded, forKey: sessionsKey)
        }
    }

    // MARK: - Export / Import Config

    /// Export an agent's configuration as a JSON-compatible dictionary
    func exportConfig(for agent: Agent) -> [String: Any] {
        var config: [String: Any] = [
            "name": agent.name,
            "description": agent.description,
            "model": agent.model,
            "system_prompt": agent.systemPrompt,
            "max_tokens": agent.maxTokens,
            "temperature": agent.temperature
        ]

        if !agent.environment.isEmpty {
            config["environment"] = agent.environment
        }

        let mcpConfig: [[String: Any]] = agent.mcpServers.map { server in
            switch server.serverType {
            case .stdio:
                return [
                    "name": server.name,
                    "type": "stdio",
                    "command": server.command,
                    "args": server.args,
                    "env": server.env
                ]
            case .sse:
                return [
                    "name": server.name,
                    "type": "sse",
                    "url": server.url,
                    "env": server.env
                ]
            }
        }

        if !mcpConfig.isEmpty {
            config["mcp_servers"] = mcpConfig
        }

        return config
    }

    /// Returns a pretty-printed JSON string of the agent's full config
    func exportConfigJSON(for agent: Agent) -> String {
        let dict = exportConfig(for: agent)
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}
