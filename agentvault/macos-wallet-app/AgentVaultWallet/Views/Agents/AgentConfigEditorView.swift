import SwiftUI

/// Full-featured editor for all agent configuration fields.
struct AgentConfigEditorView: View {
    @EnvironmentObject var agentStore: AgentStore
    @Environment(\.dismiss) private var dismiss

    // Input state (copy of agent's current values)
    @State private var name: String
    @State private var description: String
    @State private var model: String
    @State private var systemPrompt: String
    @State private var maxTokensText: String
    @State private var temperature: Double
    @State private var canisterId: String
    @State private var envText: String
    @State private var useCustomModel: Bool

    private let agentId: UUID

    init(agent: Agent) {
        self.agentId = agent.id
        _name = State(initialValue: agent.name)
        _description = State(initialValue: agent.description)
        _model = State(initialValue: agent.model)
        _systemPrompt = State(initialValue: agent.systemPrompt)
        _maxTokensText = State(initialValue: "\(agent.maxTokens)")
        _temperature = State(initialValue: agent.temperature)
        _canisterId = State(initialValue: agent.canisterId ?? "")
        _envText = State(initialValue: agent.environment.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: "\n"))
        _useCustomModel = State(initialValue: !KnownModel.allDisplayNames.contains(agent.model))
    }

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Edit Agent")
                        .font(.title2.bold())
                    Text("Update configuration for this agent")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .buttonStyle(.bordered)
                Button("Save Changes") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
            }
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Identity
                    editorSection("Identity", icon: "tag") {
                        LabeledTextField(label: "Name", placeholder: "Agent name", text: $name)
                        LabeledTextField(label: "Description", placeholder: "What does this agent do?", text: $description)
                        LabeledTextField(label: "Canister ID", placeholder: "e.g. aaaaa-aa (optional)", text: $canisterId)
                    }

                    // Model
                    editorSection("Model", icon: "brain") {
                        Toggle("Use custom model ID", isOn: $useCustomModel)
                            .padding(.bottom, 4)

                        if useCustomModel {
                            LabeledTextField(label: "Model ID", placeholder: "e.g. claude-opus-4-6", text: $model)
                        } else {
                            LabeledPicker(label: "Model", selection: $model, options: KnownModel.allDisplayNames)
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Max Tokens")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            TextField("e.g. 8096", text: $maxTokensText)
                                .textFieldStyle(.roundedBorder)
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Temperature")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(String(format: "%.2f", temperature))
                                    .font(.body.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Slider(value: $temperature, in: 0...2, step: 0.05)
                        }
                    }

                    // System Prompt
                    editorSection("System Prompt", icon: "text.quote") {
                        TextEditor(text: $systemPrompt)
                            .font(.body.monospaced())
                            .frame(minHeight: 120, maxHeight: 200)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        Text("This prompt is prepended to every conversation as a system message.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }

                    // Environment Variables
                    editorSection("Environment Variables", icon: "key.horizontal") {
                        TextEditor(text: $envText)
                            .font(.body.monospaced())
                            .frame(minHeight: 80, maxHeight: 160)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        Text("One KEY=VALUE per line. Lines starting with # are ignored.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(20)
            }
        }
    }

    // MARK: - Save

    private func save() {
        guard var agent = agentStore.agents.first(where: { $0.id == agentId }) else { return }

        agent.name = name.trimmingCharacters(in: .whitespaces)
        agent.description = description.trimmingCharacters(in: .whitespaces)
        agent.model = model.trimmingCharacters(in: .whitespaces)
        agent.systemPrompt = systemPrompt
        agent.maxTokens = Int(maxTokensText) ?? agent.maxTokens
        agent.temperature = temperature
        agent.canisterId = canisterId.trimmingCharacters(in: .whitespaces).isEmpty ? nil : canisterId.trimmingCharacters(in: .whitespaces)
        agent.environment = MCPServer.parseEnvLines(envText)

        agentStore.updateAgent(agent)
        dismiss()
    }

    // MARK: - Helpers

    @ViewBuilder
    private func editorSection<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon)
                .font(.headline)

            content()
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Reusable Form Components

struct LabeledTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
        }
    }
}

struct LabeledPicker: View {
    let label: String
    @Binding var selection: String
    let options: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Picker(label, selection: $selection) {
                ForEach(options, id: \.self) { option in
                    Text(option).tag(option)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
    }
}
