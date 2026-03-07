import SwiftUI
import Foundation

// MARK: - MCP Server Type

enum MCPServerType: String, Codable, CaseIterable, Identifiable {
    case stdio = "stdio"
    case sse = "SSE"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .stdio: return "Stdio"
        case .sse: return "SSE (HTTP)"
        }
    }

    var iconName: String {
        switch self {
        case .stdio: return "terminal"
        case .sse: return "network"
        }
    }

    var description: String {
        switch self {
        case .stdio: return "Runs a local process and communicates via stdin/stdout"
        case .sse: return "Connects to a remote server via HTTP Server-Sent Events"
        }
    }
}

// MARK: - MCP Server Model

struct MCPServer: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var serverType: MCPServerType
    /// The command to execute (for stdio type)
    var command: String
    /// Command-line arguments (for stdio type)
    var args: [String]
    /// Environment variables passed to the server process
    var env: [String: String]
    /// The URL of the SSE endpoint (for sse type)
    var url: String
    var isEnabled: Bool

    init(
        id: UUID = UUID(),
        name: String,
        serverType: MCPServerType = .stdio,
        command: String = "",
        args: [String] = [],
        env: [String: String] = [:],
        url: String = "",
        isEnabled: Bool = true
    ) {
        self.id = id
        self.name = name
        self.serverType = serverType
        self.command = command
        self.args = args
        self.env = env
        self.url = url
        self.isEnabled = isEnabled
    }

    /// Formatted args as a single string for display
    var argsString: String {
        args.joined(separator: " ")
    }

    /// Summary for list display
    var summary: String {
        switch serverType {
        case .stdio:
            let parts = ([command] + args).filter { !$0.isEmpty }
            return parts.joined(separator: " ")
        case .sse:
            return url.isEmpty ? "(no URL)" : url
        }
    }

    /// Convert env dict to formatted lines for editing
    var envLines: String {
        env.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: "\n")
    }

    /// Parse env from formatted lines
    static func parseEnvLines(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            let parts = trimmed.split(separator: "=", maxSplits: 1)
            if parts.count == 2 {
                result[String(parts[0])] = String(parts[1])
            }
        }
        return result
    }
}

// MARK: - Well-Known MCP Servers

struct MCPServerTemplate {
    let name: String
    let serverType: MCPServerType
    let command: String
    let args: [String]
    let description: String

    static let templates: [MCPServerTemplate] = [
        MCPServerTemplate(
            name: "filesystem",
            serverType: .stdio,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"],
            description: "Read/write local files"
        ),
        MCPServerTemplate(
            name: "github",
            serverType: .stdio,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            description: "Interact with GitHub repos and issues"
        ),
        MCPServerTemplate(
            name: "brave-search",
            serverType: .stdio,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-brave-search"],
            description: "Web search via Brave Search API"
        ),
        MCPServerTemplate(
            name: "memory",
            serverType: .stdio,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-memory"],
            description: "Persistent key-value memory store"
        ),
        MCPServerTemplate(
            name: "sqlite",
            serverType: .stdio,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/path/to/db.sqlite"],
            description: "Query and manage SQLite databases"
        ),
    ]

    func toMCPServer() -> MCPServer {
        MCPServer(name: name, serverType: serverType, command: command, args: args)
    }
}
