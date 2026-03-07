import SwiftUI

/// Sheet for adding or editing an MCP server on an agent
struct AddMCPServerSheet: View {
    let agentId: UUID
    let editingServer: MCPServer?

    @EnvironmentObject var agentStore: AgentStore
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var serverType: MCPServerType
    @State private var command: String
    @State private var argsText: String
    @State private var url: String
    @State private var envText: String
    @State private var isEnabled: Bool
    @State private var showTemplates = false

    init(agentId: UUID, editingServer: MCPServer?) {
        self.agentId = agentId
        self.editingServer = editingServer

        _name = State(initialValue: editingServer?.name ?? "")
        _serverType = State(initialValue: editingServer?.serverType ?? .stdio)
        _command = State(initialValue: editingServer?.command ?? "")
        _argsText = State(initialValue: editingServer?.args.joined(separator: " ") ?? "")
        _url = State(initialValue: editingServer?.url ?? "")
        _envText = State(initialValue: editingServer?.envLines ?? "")
        _isEnabled = State(initialValue: editingServer?.isEnabled ?? true)
    }

    var isEditing: Bool { editingServer != nil }

    var isValid: Bool {
        let nameTrimmed = name.trimmingCharacters(in: .whitespaces)
        guard !nameTrimmed.isEmpty else { return false }
        switch serverType {
        case .stdio: return !command.trimmingCharacters(in: .whitespaces).isEmpty
        case .sse: return !url.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isEditing ? "Edit MCP Server" : "Add MCP Server")
                        .font(.title2.bold())
                    Text("Configure a Model Context Protocol server")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if !isEditing {
                    Button {
                        showTemplates.toggle()
                    } label: {
                        Label("Templates", systemImage: "square.stack")
                    }
                    .buttonStyle(.bordered)
                }
                Button("Cancel") { dismiss() }
                    .buttonStyle(.bordered)
                Button(isEditing ? "Save" : "Add Server") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
            }
            .padding(20)

            Divider()

            // Template picker (optional)
            if showTemplates && !isEditing {
                templatePicker
                Divider()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Basic info
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Server Info", systemImage: "info.circle")
                            .font(.headline)

                        LabeledTextField(label: "Server Name", placeholder: "e.g. filesystem, github, memory", text: $name)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Server Type")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Picker("Server Type", selection: $serverType) {
                                ForEach(MCPServerType.allCases) { type in
                                    Label(type.displayName, systemImage: type.iconName).tag(type)
                                }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }

                        Text(serverType.description)
                            .font(.caption)
                            .foregroundStyle(.tertiary)

                        Toggle("Enabled", isOn: $isEnabled)
                    }
                    .padding(16)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))

                    // Connection details
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Connection", systemImage: "network")
                            .font(.headline)

                        if serverType == .stdio {
                            LabeledTextField(label: "Command", placeholder: "e.g. npx, node, python", text: $command)
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Arguments")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                TextEditor(text: $argsText)
                                    .font(.body.monospaced())
                                    .frame(minHeight: 60, maxHeight: 100)
                                    .scrollContentBackground(.hidden)
                                    .padding(8)
                                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                                Text("Space-separated. Each word is a separate argument.")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        } else {
                            LabeledTextField(label: "URL", placeholder: "https://your-server.com/mcp/sse", text: $url)
                        }
                    }
                    .padding(16)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))

                    // Environment variables
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Environment Variables", systemImage: "key.horizontal")
                            .font(.headline)

                        TextEditor(text: $envText)
                            .font(.body.monospaced())
                            .frame(minHeight: 80, maxHeight: 140)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        Text("One KEY=VALUE per line. Lines starting with # are ignored. Use this for API keys.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(16)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                }
                .padding(20)
            }
        }
    }

    // MARK: - Template Picker

    private var templatePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(MCPServerTemplate.templates, id: \.name) { template in
                    Button {
                        applyTemplate(template)
                        showTemplates = false
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: template.serverType.iconName)
                                    .foregroundStyle(.blue)
                                Text(template.name)
                                    .font(.subheadline.weight(.medium))
                            }
                            Text(template.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        .padding(10)
                        .frame(width: 160, alignment: .leading)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    // MARK: - Actions

    private func applyTemplate(_ template: MCPServerTemplate) {
        name = template.name
        serverType = template.serverType
        command = template.command
        argsText = template.args.joined(separator: " ")
    }

    private func save() {
        let args = argsText.split(separator: " ").map(String.init)
        let env = MCPServer.parseEnvLines(envText)

        if isEditing, let existing = editingServer {
            var updated = existing
            updated.name = name.trimmingCharacters(in: .whitespaces)
            updated.serverType = serverType
            updated.command = command.trimmingCharacters(in: .whitespaces)
            updated.args = args
            updated.url = url.trimmingCharacters(in: .whitespaces)
            updated.env = env
            updated.isEnabled = isEnabled
            agentStore.updateMCPServer(updated, in: agentId)
        } else {
            let server = MCPServer(
                name: name.trimmingCharacters(in: .whitespaces),
                serverType: serverType,
                command: command.trimmingCharacters(in: .whitespaces),
                args: args,
                env: env,
                url: url.trimmingCharacters(in: .whitespaces),
                isEnabled: isEnabled
            )
            agentStore.addMCPServer(server, to: agentId)
        }
        dismiss()
    }
}
