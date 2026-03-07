import SwiftUI
import Foundation

/// Manages the active chat session and message sending for a given agent
@MainActor
final class ChatViewModel: ObservableObject {

    // MARK: - Published State

    @Published var inputText: String = ""
    @Published var isSending: Bool = false
    @Published var errorMessage: String?
    @Published var activeSessionId: UUID?
    @Published var selectedAgentId: UUID?

    // MARK: - Dependencies

    private weak var agentStore: AgentStore?

    // MARK: - Init

    init(agentStore: AgentStore) {
        self.agentStore = agentStore
    }

    // MARK: - Computed

    var activeSession: ChatSession? {
        guard let id = activeSessionId else { return nil }
        return agentStore?.sessions.first { $0.id == id }
    }

    var messages: [ChatMessage] {
        activeSession?.messages.filter { $0.role != .system } ?? []
    }

    var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    // MARK: - Session Management

    func selectAgent(_ agentId: UUID) {
        selectedAgentId = agentId
        // Look for an existing session or create a new one
        if let existing = agentStore?.sessions(for: agentId).first {
            activeSessionId = existing.id
        } else {
            newSession(for: agentId)
        }
    }

    func newSession(for agentId: UUID) {
        guard let store = agentStore else { return }
        let session = store.createSession(for: agentId)
        activeSessionId = session.id
        selectedAgentId = agentId
    }

    func selectSession(_ sessionId: UUID) {
        activeSessionId = sessionId
    }

    func deleteSession(_ session: ChatSession) {
        agentStore?.deleteSession(session)
        if activeSessionId == session.id {
            if let agentId = selectedAgentId,
               let next = agentStore?.sessions(for: agentId).first {
                activeSessionId = next.id
            } else {
                activeSessionId = nil
            }
        }
    }

    // MARK: - Sending Messages

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let sessionId = activeSessionId, let agentId = selectedAgentId else { return }

        inputText = ""
        isSending = true
        errorMessage = nil

        // Add user message
        let userMsg = ChatMessage(agentId: agentId, role: .user, content: text)
        agentStore?.appendMessage(userMsg, to: sessionId)

        // Simulate assistant response (stub — replace with real API call)
        Task {
            await simulateResponse(for: sessionId, agentId: agentId)
            self.isSending = false
        }
    }

    // MARK: - Response Simulation
    // TODO: Replace with real Anthropic/inference API call using agent's model + system prompt

    private func simulateResponse(for sessionId: UUID, agentId: UUID) async {
        // Add a streaming placeholder
        let placeholder = ChatMessage(
            agentId: agentId,
            role: .assistant,
            content: "",
            isStreaming: true
        )
        agentStore?.appendMessage(placeholder, to: sessionId)

        // Simulate streaming chunks
        let response = buildSimulatedResponse(agentId: agentId)
        var accumulated = ""
        for char in response {
            try? await Task.sleep(nanoseconds: 8_000_000) // 8ms per char
            accumulated.append(char)
            agentStore?.updateLastMessage(accumulated, in: sessionId)
        }
    }

    private func buildSimulatedResponse(agentId: UUID) -> String {
        guard let agent = agentStore?.agents.first(where: { $0.id == agentId }) else {
            return "Hello! I'm ready to help."
        }
        let mcpInfo = agent.mcpServers.isEmpty
            ? "I have no MCP servers configured."
            : "I have access to \(agent.mcpServers.count) MCP server(s): \(agent.mcpServers.map(\.name).joined(separator: ", "))."
        return "Hello! I'm **\(agent.name)**, running on `\(agent.model)`. \(mcpInfo) How can I assist you today?"
    }

    // MARK: - Helpers

    func clearError() {
        errorMessage = nil
    }
}
