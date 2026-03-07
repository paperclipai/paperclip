import SwiftUI

/// Sheet for creating a new primary agent or sub-agent
struct CreateAgentSheet: View {
    let parentAgentId: UUID?

    @EnvironmentObject var agentStore: AgentStore
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var description: String = ""
    @State private var model: String = "claude-opus-4-6"
    @State private var systemPrompt: String = ""
    @State private var useCustomModel = false
    @State private var step: CreateStep = .identity

    enum CreateStep: Int, CaseIterable {
        case identity, model, prompt, confirm

        var title: String {
            switch self {
            case .identity: return "Name & Type"
            case .model: return "Model"
            case .prompt: return "System Prompt"
            case .confirm: return "Confirm"
            }
        }

        var icon: String {
            switch self {
            case .identity: return "tag"
            case .model: return "brain"
            case .prompt: return "text.quote"
            case .confirm: return "checkmark.circle"
            }
        }
    }

    var isSubAgent: Bool { parentAgentId != nil }

    var parentAgent: Agent? {
        guard let id = parentAgentId else { return nil }
        return agentStore.agents.first { $0.id == id }
    }

    var canProceed: Bool {
        switch step {
        case .identity: return !name.trimmingCharacters(in: .whitespaces).isEmpty
        case .model: return !model.trimmingCharacters(in: .whitespaces).isEmpty
        case .prompt: return true
        case .confirm: return true
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isSubAgent ? "New Sub-Agent" : "New Agent")
                        .font(.title2.bold())
                    if let parent = parentAgent {
                        Text("Sub-agent of \(parent.name)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Create a new autonomous agent")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                    .buttonStyle(.bordered)
            }
            .padding(20)

            // Step indicator
            stepIndicator
                .padding(.horizontal, 20)
                .padding(.bottom, 16)

            Divider()

            // Step content
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch step {
                    case .identity:
                        identityStep
                    case .model:
                        modelStep
                    case .prompt:
                        promptStep
                    case .confirm:
                        confirmStep
                    }
                }
                .padding(20)
            }

            Divider()

            // Navigation buttons
            HStack {
                if step != .identity {
                    Button("Back") {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            step = CreateStep(rawValue: step.rawValue - 1) ?? .identity
                        }
                    }
                    .buttonStyle(.bordered)
                }

                Spacer()

                if step == .confirm {
                    Button("Create Agent") {
                        createAgent()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canProceed)
                } else {
                    Button("Next") {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            step = CreateStep(rawValue: step.rawValue + 1) ?? .confirm
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canProceed)
                }
            }
            .padding(20)
        }
    }

    // MARK: - Step Indicator

    private var stepIndicator: some View {
        HStack(spacing: 0) {
            ForEach(Array(CreateStep.allCases.enumerated()), id: \.element.rawValue) { idx, s in
                HStack(spacing: 6) {
                    ZStack {
                        Circle()
                            .fill(s.rawValue <= step.rawValue ? .primary : .quaternary)
                            .frame(width: 24, height: 24)
                        if s.rawValue < step.rawValue {
                            Image(systemName: "checkmark")
                                .font(.caption.bold())
                                .foregroundStyle(.white)
                        } else {
                            Text("\(idx + 1)")
                                .font(.caption.bold())
                                .foregroundStyle(s.rawValue == step.rawValue ? .white : .secondary)
                        }
                    }
                    Text(s.title)
                        .font(.caption)
                        .foregroundStyle(s.rawValue == step.rawValue ? .primary : .secondary)
                }
                if idx < CreateStep.allCases.count - 1 {
                    Rectangle()
                        .fill(s.rawValue < step.rawValue ? .primary : .quaternary)
                        .frame(height: 1)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    // MARK: - Steps

    private var identityStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Agent Identity", systemImage: "tag")
                .font(.headline)

            LabeledTextField(label: "Name *", placeholder: isSubAgent ? "e.g. Researcher, Writer, Coder" : "e.g. My Assistant", text: $name)

            LabeledTextField(label: "Description", placeholder: "What does this agent do?", text: $description)

            if isSubAgent {
                HStack(spacing: 10) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.blue)
                    Text("This sub-agent will be spawned by and report to its parent agent.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(12)
                .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var modelStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Model Selection", systemImage: "brain")
                .font(.headline)

            Toggle("Use custom model ID", isOn: $useCustomModel)

            if useCustomModel {
                LabeledTextField(label: "Model ID", placeholder: "e.g. claude-opus-4-6", text: $model)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Model")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Picker("Model", selection: $model) {
                        ForEach(KnownModel.allDisplayNames, id: \.self) { m in
                            Text(m).tag(m)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
            }

            Text("You can change the model at any time in the agent's configuration.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var promptStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("System Prompt", systemImage: "text.quote")
                .font(.headline)

            TextEditor(text: $systemPrompt)
                .font(.body.monospaced())
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))

            Text("Optional. Defines the agent's personality, role, and behavior for every conversation.")
                .font(.caption)
                .foregroundStyle(.tertiary)

            // Quick templates
            VStack(alignment: .leading, spacing: 8) {
                Text("Quick Templates")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(SystemPromptTemplate.templates, id: \.name) { tpl in
                            Button {
                                systemPrompt = tpl.prompt
                            } label: {
                                Text(tpl.name)
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var confirmStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Review & Confirm", systemImage: "checkmark.circle")
                .font(.headline)

            VStack(spacing: 0) {
                ConfirmRow(label: "Name", value: name)
                Divider().padding(.leading, 12)
                if !description.isEmpty {
                    ConfirmRow(label: "Description", value: description)
                    Divider().padding(.leading, 12)
                }
                ConfirmRow(label: "Type", value: isSubAgent ? "Sub-Agent" : "Primary Agent")
                Divider().padding(.leading, 12)
                ConfirmRow(label: "Model", value: model)
                if !systemPrompt.isEmpty {
                    Divider().padding(.leading, 12)
                    ConfirmRow(label: "System Prompt", value: String(systemPrompt.prefix(60)) + (systemPrompt.count > 60 ? "…" : ""))
                }
            }
            .cardStyle()

            Text("You can add MCP servers, sub-agents, and environment variables after creation.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Create Action

    private func createAgent() {
        _ = agentStore.createAgent(
            name: name.trimmingCharacters(in: .whitespaces),
            description: description.trimmingCharacters(in: .whitespaces),
            agentType: parentAgentId == nil ? .primary : .subAgent,
            parentAgentId: parentAgentId,
            model: model.trimmingCharacters(in: .whitespaces),
            systemPrompt: systemPrompt
        )
        dismiss()
    }
}

// MARK: - Confirm Row

struct ConfirmRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.body)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.body)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 12)
    }
}

// MARK: - System Prompt Templates

struct SystemPromptTemplate {
    let name: String
    let prompt: String

    static let templates: [SystemPromptTemplate] = [
        SystemPromptTemplate(
            name: "Coding Assistant",
            prompt: "You are an expert software engineer. Help the user write clean, efficient, well-documented code. Prefer concise solutions and always consider edge cases."
        ),
        SystemPromptTemplate(
            name: "Researcher",
            prompt: "You are a research assistant. Your goal is to gather, synthesize, and summarize information accurately. Always cite your reasoning and flag uncertainty."
        ),
        SystemPromptTemplate(
            name: "Writer",
            prompt: "You are a professional writer and editor. Help craft clear, engaging content. Adapt your tone to the user's needs and offer constructive feedback."
        ),
        SystemPromptTemplate(
            name: "Data Analyst",
            prompt: "You are a data analyst. Help explore, visualize, and interpret data. Provide statistical insights and suggest appropriate analysis techniques."
        ),
        SystemPromptTemplate(
            name: "Task Planner",
            prompt: "You are a project manager. Break down complex goals into actionable tasks, track progress, and ensure nothing is missed."
        ),
    ]
}
