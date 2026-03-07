import SwiftUI

/// Full configuration detail and editor for a single agent.
/// This is the main "config hub" panel.
struct AgentDetailView: View {
    let agent: Agent

    @EnvironmentObject var agentStore: AgentStore
    @EnvironmentObject var appState: AppState
    @State private var showEditConfig = false
    @State private var showCreateSubAgent = false
    @State private var showAddMCP = false
    @State private var showDeleteConfirm = false
    @State private var showExportSheet = false
    @State private var exportedJSON = ""
    @State private var selectedMCPServer: MCPServer?

    private var current: Agent {
        agentStore.agents.first { $0.id == agent.id } ?? agent
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                headerSection
                Divider()
                configSection
                Divider()
                mcpServersSection
                Divider()
                subAgentsSection
                Divider()
                environmentSection
                Divider()
                dangerZone
            }
        }
        .navigationTitle(current.name)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    exportedJSON = agentStore.exportConfigJSON(for: current)
                    showExportSheet = true
                } label: {
                    Label("Export Config", systemImage: "arrow.up.doc")
                }

                Button {
                    showEditConfig = true
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .sheet(isPresented: $showEditConfig) {
            AgentConfigEditorView(agent: current)
                .environmentObject(agentStore)
                .frame(width: 620, height: 680)
        }
        .sheet(isPresented: $showCreateSubAgent) {
            CreateAgentSheet(parentAgentId: current.id)
                .environmentObject(agentStore)
                .frame(width: 540, height: 560)
        }
        .sheet(isPresented: $showAddMCP) {
            AddMCPServerSheet(agentId: current.id, editingServer: nil)
                .environmentObject(agentStore)
                .frame(width: 560, height: 560)
        }
        .sheet(item: $selectedMCPServer) { server in
            AddMCPServerSheet(agentId: current.id, editingServer: server)
                .environmentObject(agentStore)
                .frame(width: 560, height: 560)
        }
        .sheet(isPresented: $showExportSheet) {
            ExportConfigSheet(agentName: current.name, json: exportedJSON)
                .frame(width: 580, height: 500)
        }
        .confirmationDialog(
            "Delete \"\(current.name)\"?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete Agent", role: .destructive) {
                agentStore.deleteAgent(current)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete the agent and all its chat history. This cannot be undone.")
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 14)
                    .fill(current.agentType.color.gradient)
                    .frame(width: 56, height: 56)
                Image(systemName: current.agentType.iconName)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(current.name)
                    .font(.title2.bold())

                if !current.description.isEmpty {
                    Text(current.description)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    Label(current.agentType.rawValue, systemImage: current.agentType.iconName)
                        .font(.caption)
                        .foregroundStyle(current.agentType.color)

                    Label(current.status.rawValue, systemImage: current.status.iconName)
                        .font(.caption)
                        .foregroundStyle(current.status.color)

                    if let canisterId = current.canisterId {
                        Label(canisterId, systemImage: "cube")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
        .padding(24)
    }

    // MARK: - Core Config

    private var configSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Configuration", icon: "slider.horizontal.3")

            VStack(spacing: 0) {
                ConfigRow(label: "Model", value: current.model, icon: "brain")
                Divider().padding(.leading, 40)
                ConfigRow(label: "Max Tokens", value: "\(current.maxTokens)", icon: "number")
                Divider().padding(.leading, 40)
                ConfigRow(label: "Temperature", value: String(format: "%.2f", current.temperature), icon: "thermometer.medium")
                Divider().padding(.leading, 40)
                ConfigRow(label: "Created", value: current.createdAt.formatted(date: .abbreviated, time: .shortened), icon: "calendar")
            }
            .cardStyle()
            .padding(.horizontal, 20)
            .padding(.bottom, 8)

            // System Prompt
            VStack(alignment: .leading, spacing: 8) {
                Label("System Prompt", systemImage: "text.quote")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)

                if current.systemPrompt.isEmpty {
                    Text("No system prompt configured.")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 20)
                } else {
                    Text(current.systemPrompt)
                        .font(.body.monospaced())
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal, 20)
                }
            }
            .padding(.bottom, 20)
        }
    }

    // MARK: - MCP Servers

    private var mcpServersSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionHeader(title: "MCP Servers", icon: "server.rack")
                Spacer()
                Button {
                    showAddMCP = true
                } label: {
                    Label("Add Server", systemImage: "plus")
                        .font(.subheadline)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(.trailing, 20)
                .padding(.top, 16)
            }

            if current.mcpServers.isEmpty {
                HStack {
                    Image(systemName: "server.rack")
                        .foregroundStyle(.tertiary)
                    Text("No MCP servers configured.")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Add Server") { showAddMCP = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(current.mcpServers.enumerated()), id: \.element.id) { idx, server in
                        MCPServerRowView(server: server) {
                            selectedMCPServer = server
                        } onDelete: {
                            agentStore.removeMCPServer(server, from: current.id)
                        }
                        if idx < current.mcpServers.count - 1 {
                            Divider().padding(.leading, 40)
                        }
                    }
                }
                .cardStyle()
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
    }

    // MARK: - Sub-Agents

    private var subAgentsSection: some View {
        let subs = agentStore.subAgents(of: current)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionHeader(title: "Sub-Agents", icon: "arrow.triangle.branch")
                Spacer()
                Button {
                    showCreateSubAgent = true
                } label: {
                    Label("Add Sub-Agent", systemImage: "plus")
                        .font(.subheadline)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(.trailing, 20)
                .padding(.top, 16)
            }

            if subs.isEmpty {
                HStack {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(.tertiary)
                    Text("No sub-agents. Sub-agents can be spawned by this agent to perform parallel tasks.")
                        .foregroundStyle(.secondary)
                        .font(.body)
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(subs.enumerated()), id: \.element.id) { idx, sub in
                        HStack(spacing: 10) {
                            Image(systemName: sub.agentType.iconName)
                                .foregroundStyle(sub.agentType.color)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(sub.name)
                                    .font(.body)
                                Text(sub.configSummary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Circle()
                                .fill(sub.status.color)
                                .frame(width: 7, height: 7)
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 12)
                        if idx < subs.count - 1 {
                            Divider().padding(.leading, 42)
                        }
                    }
                }
                .cardStyle()
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
    }

    // MARK: - Environment Variables

    private var environmentSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Environment Variables", icon: "key.horizontal")

            if current.environment.isEmpty {
                HStack {
                    Image(systemName: "key.horizontal")
                        .foregroundStyle(.tertiary)
                    Text("No environment variables set.")
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(current.environment.sorted(by: { $0.key < $1.key }).enumerated()), id: \.element.key) { idx, pair in
                        HStack {
                            Text(pair.key)
                                .font(.body.monospaced())
                                .foregroundStyle(.primary)
                            Spacer()
                            Text(pair.value.isEmpty ? "(empty)" : "••••••••")
                                .font(.body.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 7)
                        .padding(.horizontal, 12)
                        if idx < current.environment.count - 1 {
                            Divider().padding(.leading, 12)
                        }
                    }
                }
                .cardStyle()
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
    }

    // MARK: - Danger Zone

    private var dangerZone: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Danger Zone", icon: "exclamationmark.triangle")
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Delete Agent")
                        .font(.body.weight(.medium))
                    Text("Permanently remove this agent, its sub-agents, and all chat history.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Delete Agent", role: .destructive) {
                    showDeleteConfirm = true
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.regular)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 28)
        }
    }
}

// MARK: - Supporting Views

struct SectionHeader: View {
    let title: String
    let icon: String

    var body: some View {
        Label(title, systemImage: icon)
            .font(.headline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)
    }
}

struct ConfigRow: View {
    let label: String
    let value: String
    let icon: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(label)
                .font(.body)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.body.monospaced())
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
    }
}

// MARK: - Export Config Sheet

struct ExportConfigSheet: View {
    let agentName: String
    let json: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Export Config")
                        .font(.title2.bold())
                    Text("\(agentName) · JSON")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.bordered)
            }
            .padding(20)

            Divider()

            ScrollView {
                Text(json)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .padding(16)

            HStack {
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(json, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
                } label: {
                    Label(copied ? "Copied!" : "Copy JSON", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
    }
}
