import SwiftUI

/// Main chat interface — three-pane layout: sessions list | messages | agent info
struct ChatView: View {
    @EnvironmentObject var agentStore: AgentStore
    @EnvironmentObject var appState: AppState
    @State private var vm: ChatViewModel?

    var body: some View {
        Group {
            if let vm = vm {
                wiredChatView(vm: vm)
            } else {
                Color.clear
            }
        }
        .navigationTitle("Chat")
        .onAppear {
            if vm == nil {
                let newVM = ChatViewModel(agentStore: agentStore)
                if let first = agentStore.primaryAgents.first {
                    newVM.selectAgent(first.id)
                }
                vm = newVM
            }
        }
    }

    @ViewBuilder
    private func wiredChatView(vm: ChatViewModel) -> some View {
        HSplitView {
            // Left panel: session list + agent picker
            SessionListPanel(vm: vm)
                .frame(minWidth: 200, maxWidth: 260)

            // Center: message thread
            if vm.activeSessionId != nil {
                MessageThreadView(vm: vm)
            } else {
                noChatSelected(vm: vm)
            }

            // Right panel: agent info
            if let agentId = vm.selectedAgentId,
               let agent = agentStore.agents.first(where: { $0.id == agentId }) {
                ChatAgentInfoPanel(agent: agent)
                    .frame(minWidth: 200, maxWidth: 240)
            }
        }
    }

    private func noChatSelected(vm: ChatViewModel) -> some View {
        ContentUnavailableView {
            Label("No Chat Selected", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text("Select an agent and start a new conversation.")
        } actions: {
            if let first = agentStore.primaryAgents.first {
                Button("Start Chatting") {
                    vm.selectAgent(first.id)
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

// MARK: - Session List Panel

struct SessionListPanel: View {
    @ObservedObject var vm: ChatViewModel
    @EnvironmentObject var agentStore: AgentStore

    var body: some View {
        VStack(spacing: 0) {
            // Agent picker
            VStack(spacing: 8) {
                Text("Agent")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if agentStore.primaryAgents.isEmpty {
                    Text("No agents yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                } else {
                    Picker("Agent", selection: Binding(
                        get: { vm.selectedAgentId },
                        set: { id in
                            if let id = id { vm.selectAgent(id) }
                        }
                    )) {
                        ForEach(agentStore.primaryAgents) { agent in
                            Text(agent.name).tag(Optional(agent.id))
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Divider()

            // Session list
            if let agentId = vm.selectedAgentId {
                let sessions = agentStore.sessions(for: agentId)
                if sessions.isEmpty {
                    Spacer()
                    Text("No chats yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer()
                } else {
                    List(selection: Binding(
                        get: { vm.activeSessionId },
                        set: { id in if let id = id { vm.selectSession(id) } }
                    )) {
                        ForEach(sessions) { session in
                            SessionRow(session: session, onDelete: {
                                vm.deleteSession(session)
                            })
                            .tag(session.id)
                        }
                    }
                    .listStyle(.sidebar)
                }
            } else {
                Spacer()
                Text("Select an agent to chat")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding()
                Spacer()
            }

            Divider()

            // New chat button
            Button {
                if let id = vm.selectedAgentId {
                    vm.newSession(for: id)
                }
            } label: {
                Label("New Chat", systemImage: "plus.bubble")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .disabled(vm.selectedAgentId == nil)
            .padding(12)
        }
        .background(.windowBackground)
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: ChatSession
    let onDelete: () -> Void
    @State private var showDeleteConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(session.title)
                .font(.body)
                .lineLimit(1)
            Text(session.previewText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(session.updatedAt.relativeString)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .contextMenu {
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .confirmationDialog("Delete this chat?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { onDelete() }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// MARK: - Message Thread View

struct MessageThreadView: View {
    @ObservedObject var vm: ChatViewModel
    @EnvironmentObject var agentStore: AgentStore

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 4) {
                        if vm.messages.isEmpty {
                            emptyChatPrompt
                        } else {
                            ForEach(vm.messages) { message in
                                ChatBubbleView(message: message)
                                    .id(message.id)
                            }
                        }
                    }
                    .padding(.vertical, 16)
                    .padding(.horizontal, 12)
                }
                .onChange(of: vm.messages.count) { _, _ in
                    if let last = vm.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
                .onChange(of: vm.messages.last?.content) { _, _ in
                    if let last = vm.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            ChatInputBar(vm: vm)
        }
    }

    private var emptyChatPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text("Start the conversation")
                .font(.title3.weight(.medium))
                .foregroundStyle(.secondary)
            if let agentId = vm.selectedAgentId,
               let agent = agentStore.agents.first(where: { $0.id == agentId }) {
                Text("You're chatting with **\(agent.name)** (\(agent.model))")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }
}

// MARK: - Chat Input Bar

struct ChatInputBar: View {
    @ObservedObject var vm: ChatViewModel

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $vm.inputText)
                    .font(.body)
                    .frame(minHeight: 36, maxHeight: 120)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))

                Button {
                    vm.sendMessage()
                } label: {
                    if vm.isSending {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 32, height: 32)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(vm.canSend ? .primary : .tertiary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!vm.canSend)
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.windowBackground)
        }
    }
}

// MARK: - Agent Info Panel

struct ChatAgentInfoPanel: View {
    let agent: Agent
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(agent.agentType.color.gradient)
                        .frame(width: 32, height: 32)
                    Image(systemName: agent.agentType.iconName)
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.name)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                    Text(agent.model)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(12)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    InfoRow(label: "Status") {
                        Label(agent.status.rawValue, systemImage: agent.status.iconName)
                            .font(.caption)
                            .foregroundStyle(agent.status.color)
                    }

                    if !agent.mcpServers.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("MCP Servers")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            ForEach(agent.mcpServers.filter(\.isEnabled)) { server in
                                HStack(spacing: 4) {
                                    Image(systemName: server.serverType.iconName)
                                        .font(.caption2)
                                        .foregroundStyle(.blue)
                                    Text(server.name)
                                        .font(.caption)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }

                    if !agent.systemPrompt.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("System Prompt")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            Text(agent.systemPrompt)
                                .font(.caption)
                                .foregroundStyle(.primary)
                                .lineLimit(5)
                        }
                    }

                    Button {
                        appState.selectedDestination = .agentHub
                    } label: {
                        Label("Edit Agent Config", systemImage: "pencil")
                            .font(.caption)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(12)
            }
        }
        .background(.windowBackground)
    }
}

// MARK: - Info Row

struct InfoRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            content()
        }
    }
}
