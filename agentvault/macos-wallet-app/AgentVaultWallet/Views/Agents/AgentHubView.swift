import SwiftUI

/// The centralized Agent Management Hub — a two-panel view with agent list on the left
/// and a full config editor on the right.
struct AgentHubView: View {
    @EnvironmentObject var agentStore: AgentStore
    @EnvironmentObject var appState: AppState

    @State private var showCreateSheet = false
    @State private var searchText = ""
    @State private var selectedAgentId: UUID?

    var filteredAgents: [Agent] {
        let all = agentStore.primaryAgents
        if searchText.isEmpty { return all }
        return all.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            $0.description.localizedCaseInsensitiveContains(searchText) ||
            $0.model.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        HSplitView {
            // Left panel: agent list
            agentListPanel
                .frame(minWidth: 220, maxWidth: 280)

            // Right panel: config detail
            if let id = selectedAgentId,
               let agent = agentStore.agents.first(where: { $0.id == id }) {
                AgentDetailView(agent: agent)
            } else {
                emptySelection
            }
        }
        .navigationTitle("Agent Hub")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateSheet = true
                } label: {
                    Label("New Agent", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            CreateAgentSheet(parentAgentId: nil)
                .environmentObject(agentStore)
                .frame(width: 540, height: 560)
        }
        .onAppear {
            if selectedAgentId == nil {
                selectedAgentId = agentStore.primaryAgents.first?.id
            }
        }
    }

    // MARK: - Agent List Panel

    private var agentListPanel: some View {
        VStack(spacing: 0) {
            // Search
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search agents", text: $searchText)
                    .textFieldStyle(.plain)
            }
            .padding(8)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Divider()

            // Agent list
            if filteredAgents.isEmpty {
                Spacer()
                if agentStore.agents.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "cpu")
                            .font(.system(size: 36))
                            .foregroundStyle(.tertiary)
                        Text("No Agents Yet")
                            .font(.headline)
                            .foregroundStyle(.secondary)
                        Text("Create your first agent to get started.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                        Button("Create Agent") {
                            showCreateSheet = true
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                    .padding()
                } else {
                    Text("No results")
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                List(selection: $selectedAgentId) {
                    ForEach(filteredAgents) { agent in
                        AgentListRow(agent: agent, subAgents: agentStore.subAgents(of: agent))
                            .tag(agent.id)
                    }
                }
                .listStyle(.sidebar)
            }

            Divider()

            // Bottom create button
            Button {
                showCreateSheet = true
            } label: {
                Label("New Agent", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .padding(12)
        }
        .background(.windowBackground)
    }

    // MARK: - Empty State

    private var emptySelection: some View {
        ContentUnavailableView(
            "Select an Agent",
            systemImage: "cpu",
            description: Text("Choose an agent from the list to view and edit its configuration.")
        )
    }
}

// MARK: - Agent List Row

struct AgentListRow: View {
    let agent: Agent
    let subAgents: [Agent]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: agent.agentType.iconName)
                    .font(.caption)
                    .foregroundStyle(agent.agentType.color)

                Text(agent.name)
                    .font(.body)
                    .lineLimit(1)

                Spacer()

                Circle()
                    .fill(agent.status.color)
                    .frame(width: 7, height: 7)
            }

            Text(agent.configSummary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 3)
    }
}
