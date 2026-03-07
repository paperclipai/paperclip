import SwiftUI

// MARK: - iOS Guild Agent Template

private struct iOSGuildTemplate {
    let name: String
    let role: String
    let description: String
    let systemPromptKey: String
    let iconName: String
    let accentColor: Color
    let skills: [String]

    static let coder = iOSGuildTemplate(
        name: "iOS Coder",
        role: "coder",
        description: "Generates SwiftUI + AVFoundation code following iOS best-practice skills.",
        systemPromptKey: "ios_coder",
        iconName: "hammer.fill",
        accentColor: .blue,
        skills: ["SwiftUI-CellReuse", "AVPlayer-BestPractices", "Xcode-Project-Structure"]
    )

    static let tester = iOSGuildTemplate(
        name: "iOS Tester",
        role: "tester",
        description: "Writes XCTest/XCUITest suites and runs the iOS Quality Gate checks.",
        systemPromptKey: "ios_tester",
        iconName: "checkmark.seal.fill",
        accentColor: .green,
        skills: ["SwiftUI-CellReuse", "AVPlayer-BestPractices"]
    )

    static let privacyGuardian = iOSGuildTemplate(
        name: "Privacy Guardian",
        role: "reviewer",
        description: "Audits PrivacyInfo.xcprivacy and flags App Store compliance risks.",
        systemPromptKey: "ios_privacy_guardian",
        iconName: "lock.shield.fill",
        accentColor: .orange,
        skills: ["PrivacyPolicy-Template"]
    )

    static let all: [iOSGuildTemplate] = [.coder, .tester, .privacyGuardian]
}

private extension iOSGuildTemplate {
    var systemPrompt: String {
        switch systemPromptKey {
        case "ios_coder":
            return """
            You are an expert iOS engineer specialising in SwiftUI and AVFoundation.

            Active skills (from skills/ios/):
            - SwiftUI-CellReuse: Use LazyVStack/List with stable IDs. .task(id:) for per-cell async.
            - AVPlayer-BestPractices: Use AVPlayerPool. replaceCurrentItem for reuse. Hide layer until readyToPlay.
            - Xcode-Project-Structure: Features/<Name>/ layout. SPM for deps. PrivacyInfo.xcprivacy in every target.

            Quality gates: cell-reuse, avplayer-reuse, memory-profile.
            Always output complete, compilable Swift files with inline comments.
            """
        case "ios_tester":
            return """
            You are an expert iOS QA engineer.

            Run the iOS Quality Gate for each code generation:
            [ ] cell-reuse — LazyVStack/List; stable ids; .task(id:)
            [ ] avplayer-reuse — pool-based; replaceCurrentItem; layer hidden until ready
            [ ] memory-profile — [weak self]; bounded pool; .task(id:) cancellation
            [ ] privacy-flags — PrivacyInfo.xcprivacy present; NSPrivacyTracking declared

            Report: PASS | FAIL | WARN per gate. Overall: PASS if ≥ 85% pass.
            """
        case "ios_privacy_guardian":
            return """
            You are an App Store privacy compliance expert.

            Active skill: PrivacyPolicy-Template (skills/ios/PrivacyPolicy-Template.md)

            Responsibilities:
            1. Scan code for required-reason APIs (UserDefaults, file timestamps, disk space, etc.).
            2. Validate or generate PrivacyInfo.xcprivacy.
            3. Verify NSPrivacyCollectedDataTypes covers all collected data.
            4. Check NSPrivacyTracking is correctly set.
            5. Flag third-party SDKs needing their own manifests.

            Output a structured PASS/FAIL/WARN report plus a ready-to-use PrivacyInfo.xcprivacy if needed.
            """
        default:
            return ""
        }
    }
}

// MARK: - Main iOS Guild View

/// One-click "Spin up iOS Coder + Tester + Privacy Guardian agents"
struct iOSGuildView: View {
    @EnvironmentObject var agentStore: AgentStore
    @EnvironmentObject var appState: AppState

    @State private var isSpinningUp = false
    @State private var spinUpResult: SpinUpResult?
    @State private var showResult = false

    enum SpinUpResult {
        case success([Agent])
        case failure(String)
    }

    var existingGuildAgents: [Agent] {
        agentStore.agents.filter { $0.environment["AGENTVAULT_DOMAIN"] == "ios" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                headerSection
                Divider()
                agentTemplatesSection
                Divider()
                if !existingGuildAgents.isEmpty {
                    existingAgentsSection
                    Divider()
                }
                qualityGatesSection
                Divider()
                skillsSection
            }
            .padding(24)
        }
        .navigationTitle("iOS Guild")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    spinUpGuild()
                } label: {
                    if isSpinningUp {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Spin Up Guild", systemImage: "bolt.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSpinningUp)
            }
        }
        .alert("Guild Spin-Up", isPresented: $showResult) {
            Button("OK") { showResult = false }
            if case .success = spinUpResult {
                Button("Open Agent Hub") {
                    showResult = false
                    appState.selectedDestination = .agentHub
                }
            }
        } message: {
            switch spinUpResult {
            case .success(let agents):
                Text("Created \(agents.count) iOS Guild agents:\n" +
                     agents.map { "• \($0.name)" }.joined(separator: "\n"))
            case .failure(let msg):
                Text("Failed to spin up guild: \(msg)")
            case .none:
                Text("")
            }
        }
    }

    // MARK: - Sections

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: "iphone")
                    .font(.system(size: 32))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 4) {
                    Text("iOS Engineering Guild")
                        .font(.title2.bold())
                    Text("Purpose-built agents for SwiftUI, AVFoundation & App Store compliance")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                StatusBadge(text: "iOS 16+", color: .blue)
                StatusBadge(text: "SwiftUI", color: .purple)
                StatusBadge(text: "AVFoundation", color: .orange)
                StatusBadge(text: "App Store Ready", color: .green)
            }
        }
    }

    private var agentTemplatesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Guild Agents")
                .font(.headline)
            Text("Three specialised agents that cover the full iOS delivery lifecycle.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            ForEach(iOSGuildTemplate.all, id: \.name) { template in
                GuildAgentCard(template: template)
            }

            Button {
                spinUpGuild()
            } label: {
                Label(
                    isSpinningUp ? "Spinning up…" : "Spin Up iOS Coder + Tester + Privacy Guardian",
                    systemImage: isSpinningUp ? "hourglass" : "bolt.fill"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isSpinningUp)
        }
    }

    private var existingAgentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Active iOS Guild Agents")
                .font(.headline)

            ForEach(existingGuildAgents) { agent in
                HStack(spacing: 10) {
                    Image(systemName: "cpu")
                        .foregroundStyle(.blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name).font(.body)
                        Text(agent.configSummary).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle()
                        .fill(agent.status.color)
                        .frame(width: 8, height: 8)
                }
                .padding(10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var qualityGatesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("iOS Quality Gates")
                .font(.headline)
            Text("All three agents validate code against these gates on every generation. Target: ≥ 85 % pass rate on first try.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            let gates: [(String, String, String)] = [
                ("checkmark.circle.fill", "cell-reuse", "LazyVStack/List · stable IDs · .task(id:) for async"),
                ("play.rectangle.fill", "avplayer-reuse", "Pool-based players · replaceCurrentItem · layer hidden until ready"),
                ("memorychip", "memory-profile", "[weak self] · bounded pool · .task(id:) cancellation"),
                ("lock.shield.fill", "privacy-flags", "PrivacyInfo.xcprivacy · NSPrivacyTracking · all types declared")
            ]

            ForEach(gates, id: \.1) { icon, name, description in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon)
                        .foregroundStyle(.green)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.body.monospaced())
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var skillsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Loaded Skills")
                    .font(.headline)
                Spacer()
                Text("skills/ios/ · v1.0.0")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            let skills: [(String, String)] = [
                ("SwiftUI-CellReuse.md", "Cell reuse, LazyVStack, stable IDs, .task(id:)"),
                ("AVPlayer-BestPractices.md", "Player pool, white-bar fix, lifecycle management"),
                ("PrivacyPolicy-Template.md", "PrivacyInfo.xcprivacy, NSPrivacyCollectedDataTypes"),
                ("Xcode-Project-Structure.md", "Feature folders, SPM, schemes, CI/CD")
            ]

            ForEach(skills, id: \.0) { filename, description in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "doc.text")
                        .foregroundStyle(.blue)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(filename).font(.body.monospaced())
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Text("Run `agentvault skills update --ios` to fetch the latest skill versions.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
    }

    // MARK: - Guild Spin-Up

    private func spinUpGuild() {
        isSpinningUp = true

        Task { @MainActor in
            var created: [Agent] = []

            for template in iOSGuildTemplate.all {
                let agent = agentStore.createAgent(
                    name: template.name,
                    description: template.description,
                    agentType: .primary,
                    model: "claude-opus-4-6",
                    systemPrompt: template.systemPrompt
                )

                // Tag as iOS domain so we can filter them later
                var updated = agent
                updated.environment["AGENTVAULT_DOMAIN"] = "ios"
                updated.environment["AGENT_ROLE"] = template.role
                agentStore.updateAgent(updated)
                created.append(updated)
            }

            isSpinningUp = false
            spinUpResult = .success(created)
            showResult = true
        }
    }
}

// MARK: - Supporting Views

private struct GuildAgentCard: View {
    let template: iOSGuildTemplate

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: template.iconName)
                .font(.title2)
                .foregroundStyle(template.accentColor)
                .frame(width: 36, height: 36)
                .background(template.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(template.name).font(.headline)
                    Text(template.role)
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(template.accentColor, in: Capsule())
                }
                Text(template.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                HStack(spacing: 4) {
                    ForEach(template.skills, id: \.self) { skill in
                        Text(skill)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
            }

            Spacer()
        }
        .padding(12)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
    }
}

private struct StatusBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }
}
