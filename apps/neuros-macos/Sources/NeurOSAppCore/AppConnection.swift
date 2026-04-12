import Foundation

public struct LocalServerLaunchConfiguration: Codable, Equatable, Sendable {
    public var autoStartOnLaunch: Bool
    public var workspaceRootPath: String
    public var customCommand: String

    public init(
        autoStartOnLaunch: Bool = true,
        workspaceRootPath: String = "",
        customCommand: String = ""
    ) {
        self.autoStartOnLaunch = autoStartOnLaunch
        self.workspaceRootPath = workspaceRootPath
        self.customCommand = customCommand
    }

    public var trimmedWorkspaceRootPath: String {
        workspaceRootPath.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var trimmedCustomCommand: String {
        customCommand.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static let `default` = LocalServerLaunchConfiguration()

    private enum CodingKeys: String, CodingKey {
        case autoStartOnLaunch
        case workspaceRootPath
        case customCommand
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        autoStartOnLaunch = try container.decodeIfPresent(Bool.self, forKey: .autoStartOnLaunch) ?? true
        workspaceRootPath = try container.decodeIfPresent(String.self, forKey: .workspaceRootPath) ?? ""
        customCommand = try container.decodeIfPresent(String.self, forKey: .customCommand) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(autoStartOnLaunch, forKey: .autoStartOnLaunch)
        try container.encode(workspaceRootPath, forKey: .workspaceRootPath)
        try container.encode(customCommand, forKey: .customCommand)
    }
}

public struct ServerConnectionConfiguration: Codable, Equatable, Sendable {
    public var baseURLString: String
    public var runtimeMode: RuntimeMode
    public var localServer: LocalServerLaunchConfiguration

    public init(
        baseURLString: String = "http://127.0.0.1:3100",
        runtimeMode: RuntimeMode = .hybrid,
        localServer: LocalServerLaunchConfiguration = .default
    ) {
        self.baseURLString = baseURLString
        self.runtimeMode = runtimeMode
        self.localServer = localServer
    }

    public var trimmedBaseURLString: String {
        baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var preferredCompanyPrefix: String? {
        guard let components = normalizedComponents else { return nil }
        return Self.extractCompanyPrefix(from: components.path)
    }

    public var apiBaseURL: URL? {
        guard var components = normalizedComponents else {
            return nil
        }

        let preferredPrefix = Self.extractCompanyPrefix(from: components.path)
        components.path = Self.normalizeBasePath(components.path, preferredPrefix: preferredPrefix)

        if components.path.hasSuffix("/api") == false {
            let normalizedPath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            components.path = normalizedPath.isEmpty ? "/api" : "/\(normalizedPath)/api"
        }

        return components.url
    }

    public var resolvedHost: String? {
        apiBaseURL?.host?.lowercased()
    }

    public var targetsLocalMachine: Bool {
        guard let resolvedHost else { return false }
        return ["127.0.0.1", "localhost", "::1"].contains(resolvedHost)
    }

    public var canManageLocalServer: Bool {
        runtimeMode != .remote && targetsLocalMachine
    }

    public static let `default` = ServerConnectionConfiguration()

    private static let boardRouteRoots: Set<String> = [
        "dashboard",
        "companies",
        "company",
        "skills",
        "org",
        "agents",
        "projects",
        "execution-workspaces",
        "issues",
        "routines",
        "goals",
        "approvals",
        "costs",
        "usage",
        "activity",
        "inbox",
        "design-guide",
        "plugins",
        "settings"
    ]

    private static let globalRouteRoots: Set<String> = [
        "auth",
        "invite",
        "board-claim",
        "cli-auth",
        "docs",
        "instance"
    ]

    private static let reservedRoots: Set<String> = [
        "api",
        "health"
    ]

    private var normalizedComponents: URLComponents? {
        let normalizedBaseURL: String
        if trimmedBaseURLString.contains("://") {
            normalizedBaseURL = trimmedBaseURLString
        } else {
            normalizedBaseURL = "http://\(trimmedBaseURLString)"
        }
        guard var components = URLComponents(string: normalizedBaseURL) else {
            return nil
        }
        components.host = Self.canonicalHost(components.host)
        return components
    }

    public var canonicalized: ServerConnectionConfiguration {
        var normalized = self
        if let components = normalizedComponents?.url {
            normalized.baseURLString = components.absoluteString
        }
        return normalized
    }

    private static func extractCompanyPrefix(from path: String) -> String? {
        let segments = path.split(separator: "/").map { String($0) }
        guard let first = segments.first else { return nil }
        let firstLowercased = first.lowercased()
        if reservedRoots.contains(firstLowercased) || boardRouteRoots.contains(firstLowercased) || globalRouteRoots.contains(firstLowercased) {
            return nil
        }

        if segments.count >= 2 {
            let secondLowercased = segments[1].lowercased()
            if boardRouteRoots.contains(secondLowercased) || globalRouteRoots.contains(secondLowercased) || reservedRoots.contains(secondLowercased) {
                return first.uppercased()
            }
        }

        if looksLikeCompanyPrefix(firstLowercased) {
            return first.uppercased()
        }

        return nil
    }

    private static func normalizeBasePath(_ path: String, preferredPrefix: String?) -> String {
        let segments = path.split(separator: "/").map { String($0) }
        guard let first = segments.first else { return path }
        let firstLowercased = first.lowercased()

        if firstLowercased == "api" {
            return "/api"
        }

        if firstLowercased == "health" {
            return ""
        }

        if boardRouteRoots.contains(firstLowercased) || globalRouteRoots.contains(firstLowercased) {
            return ""
        }

        if let preferredPrefix {
            let normalizedPreferred = preferredPrefix.lowercased()
            if firstLowercased == normalizedPreferred {
                return ""
            }
        }

        if reservedRoots.contains(firstLowercased) {
            return path
        }

        if looksLikeCompanyPrefix(firstLowercased) {
            return ""
        }

        return path
    }

    private static func looksLikeCompanyPrefix(_ segment: String) -> Bool {
        let length = segment.count
        if length < 2 || length > 8 {
            return false
        }
        if reservedRoots.contains(segment) || boardRouteRoots.contains(segment) || globalRouteRoots.contains(segment) {
            return false
        }
        let allowed = CharacterSet.alphanumerics
        return segment.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func canonicalHost(_ host: String?) -> String? {
        guard let host else { return nil }
        let lowercased = host.lowercased()
        if lowercased == "localhost" || lowercased == "::1" || lowercased == "127.0.0.1" {
            return lowercased == "::1" ? "::1" : host
        }
        if lowercased.hasPrefix("127.") {
            return "127.0.0.1"
        }
        return host
    }

    private enum CodingKeys: String, CodingKey {
        case baseURLString
        case runtimeMode
        case localServer
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        baseURLString = try container.decodeIfPresent(String.self, forKey: .baseURLString) ?? "http://127.0.0.1:3100"
        runtimeMode = try container.decodeIfPresent(RuntimeMode.self, forKey: .runtimeMode) ?? .hybrid
        localServer = try container.decodeIfPresent(LocalServerLaunchConfiguration.self, forKey: .localServer) ?? .default
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(baseURLString, forKey: .baseURLString)
        try container.encode(runtimeMode, forKey: .runtimeMode)
        try container.encode(localServer, forKey: .localServer)
    }
}

public struct DevServerStatusSummary: Sendable, Equatable {
    public var restartRequired: Bool
    public var reason: String?
    public var lastChangedAt: Date?
    public var changedPathCount: Int
    public var changedPathsSample: [String]
    public var pendingMigrations: [String]
    public var autoRestartEnabled: Bool
    public var activeRunCount: Int
    public var waitingForIdle: Bool
    public var lastRestartAt: Date?

    public init(
        restartRequired: Bool,
        reason: String?,
        lastChangedAt: Date?,
        changedPathCount: Int,
        changedPathsSample: [String],
        pendingMigrations: [String],
        autoRestartEnabled: Bool,
        activeRunCount: Int,
        waitingForIdle: Bool,
        lastRestartAt: Date?
    ) {
        self.restartRequired = restartRequired
        self.reason = reason
        self.lastChangedAt = lastChangedAt
        self.changedPathCount = changedPathCount
        self.changedPathsSample = changedPathsSample
        self.pendingMigrations = pendingMigrations
        self.autoRestartEnabled = autoRestartEnabled
        self.activeRunCount = activeRunCount
        self.waitingForIdle = waitingForIdle
        self.lastRestartAt = lastRestartAt
    }
}

public struct InstanceGeneralSettingsSummary: Sendable, Equatable {
    public var censorUsernameInLogs: Bool
    public var keyboardShortcuts: Bool
    public var feedbackDataSharingPreference: String

    public init(
        censorUsernameInLogs: Bool = false,
        keyboardShortcuts: Bool = false,
        feedbackDataSharingPreference: String = "prompt"
    ) {
        self.censorUsernameInLogs = censorUsernameInLogs
        self.keyboardShortcuts = keyboardShortcuts
        self.feedbackDataSharingPreference = feedbackDataSharingPreference
    }
}

public struct InstanceExperimentalSettingsSummary: Sendable, Equatable {
    public var enableIsolatedWorkspaces: Bool
    public var autoRestartDevServerWhenIdle: Bool

    public init(
        enableIsolatedWorkspaces: Bool = false,
        autoRestartDevServerWhenIdle: Bool = false
    ) {
        self.enableIsolatedWorkspaces = enableIsolatedWorkspaces
        self.autoRestartDevServerWhenIdle = autoRestartDevServerWhenIdle
    }
}

public struct InstanceSettingsSnapshot: Sendable, Equatable {
    public var general: InstanceGeneralSettingsSummary
    public var experimental: InstanceExperimentalSettingsSummary

    public init(
        general: InstanceGeneralSettingsSummary = InstanceGeneralSettingsSummary(),
        experimental: InstanceExperimentalSettingsSummary = InstanceExperimentalSettingsSummary()
    ) {
        self.general = general
        self.experimental = experimental
    }

    public static let `default` = InstanceSettingsSnapshot()
}

public enum LocalServerPhase: String, Codable, Sendable {
    case idle
    case starting
    case running
    case failed
}

public struct LocalServerStatus: Sendable, Equatable {
    public var phase: LocalServerPhase
    public var isManagedProcess: Bool
    public var resolvedCommand: String?
    public var resolvedWorkingDirectory: String?
    public var detail: String
    public var recentOutput: [String]
    public var launchedAt: Date?
    public var lastExitAt: Date?
    public var lastExitCode: Int32?
    public var pid: Int32?

    public init(
        phase: LocalServerPhase = .idle,
        isManagedProcess: Bool = false,
        resolvedCommand: String? = nil,
        resolvedWorkingDirectory: String? = nil,
        detail: String = "Servidor local pronto para iniciar.",
        recentOutput: [String] = [],
        launchedAt: Date? = nil,
        lastExitAt: Date? = nil,
        lastExitCode: Int32? = nil,
        pid: Int32? = nil
    ) {
        self.phase = phase
        self.isManagedProcess = isManagedProcess
        self.resolvedCommand = resolvedCommand
        self.resolvedWorkingDirectory = resolvedWorkingDirectory
        self.detail = detail
        self.recentOutput = recentOutput
        self.launchedAt = launchedAt
        self.lastExitAt = lastExitAt
        self.lastExitCode = lastExitCode
        self.pid = pid
    }

    public var label: String {
        switch phase {
        case .idle: "Parado"
        case .starting: "Inicializando"
        case .running: "Em execução"
        case .failed: "Falhou"
        }
    }

    public static let idle = LocalServerStatus()
}

public struct ServerHealthSummary: Sendable {
    public var status: String
    public var version: String
    public var deploymentMode: String?
    public var deploymentExposure: String?
    public var authReady: Bool?
    public var bootstrapStatus: String?
    public var bootstrapInviteActive: Bool?
    public var devServer: DevServerStatusSummary?

    public init(
        status: String,
        version: String,
        deploymentMode: String?,
        deploymentExposure: String?,
        authReady: Bool? = nil,
        bootstrapStatus: String? = nil,
        bootstrapInviteActive: Bool? = nil,
        devServer: DevServerStatusSummary? = nil
    ) {
        self.status = status
        self.version = version
        self.deploymentMode = deploymentMode
        self.deploymentExposure = deploymentExposure
        self.authReady = authReady
        self.bootstrapStatus = bootstrapStatus
        self.bootstrapInviteActive = bootstrapInviteActive
        self.devServer = devServer
    }
}
