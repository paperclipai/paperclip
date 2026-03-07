import Foundation

// MARK: - Message Role

enum MessageRole: String, Codable, CaseIterable {
    case user = "user"
    case assistant = "assistant"
    case system = "system"
    case tool = "tool"
}

// MARK: - Chat Message

struct ChatMessage: Identifiable, Codable, Equatable {
    let id: UUID
    let agentId: UUID
    let role: MessageRole
    var content: String
    let timestamp: Date
    var isStreaming: Bool
    var errorMessage: String?

    init(
        id: UUID = UUID(),
        agentId: UUID,
        role: MessageRole,
        content: String,
        timestamp: Date = Date(),
        isStreaming: Bool = false,
        errorMessage: String? = nil
    ) {
        self.id = id
        self.agentId = agentId
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.errorMessage = errorMessage
    }
}

// MARK: - Chat Session

struct ChatSession: Identifiable, Codable {
    let id: UUID
    var agentId: UUID
    var title: String
    var messages: [ChatMessage]
    let createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        agentId: UUID,
        title: String = "New Chat",
        messages: [ChatMessage] = []
    ) {
        self.id = id
        self.agentId = agentId
        self.title = title
        self.messages = messages
        self.createdAt = Date()
        self.updatedAt = Date()
    }

    var lastMessage: ChatMessage? {
        messages.last(where: { $0.role != .system })
    }

    var previewText: String {
        lastMessage?.content.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(80)
            .description ?? "No messages yet"
    }

    /// Auto-generate a title from the first user message
    mutating func generateTitle() {
        if let first = messages.first(where: { $0.role == .user }) {
            let text = first.content.trimmingCharacters(in: .whitespacesAndNewlines)
            title = String(text.prefix(50))
            if text.count > 50 { title += "..." }
        }
    }
}
