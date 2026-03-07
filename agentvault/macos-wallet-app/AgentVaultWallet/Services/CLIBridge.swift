import Foundation

/// Bridges the macOS GUI to the AgentVault Node.js CLI.
/// Runs CLI commands as child processes and parses their output.
actor CLIBridge {
    static let shared = CLIBridge()

    enum CLIError: LocalizedError {
        case nodeNotFound
        case cliNotFound
        case commandFailed(String)
        case parseError(String)
        case timeout

        var errorDescription: String? {
            switch self {
            case .nodeNotFound:
                return "Node.js is not installed. Please install Node.js 18+ from nodejs.org or via Homebrew."
            case .cliNotFound:
                return "AgentVault CLI not found. Set the project path in Settings or run 'npm install' in the AgentVault directory."
            case .commandFailed(let msg):
                return "CLI command failed: \(msg)"
            case .parseError(let msg):
                return "Failed to parse CLI output: \(msg)"
            case .timeout:
                return "Command timed out after 60 seconds."
            }
        }
    }

    /// Cached path to the AgentVault project root
    private var projectRoot: String?

    private func parentDirectories(of path: String, maxDepth: Int = 8) -> [String] {
        var directories: [String] = []
        var current = URL(fileURLWithPath: (path as NSString).standardizingPath)

        for _ in 0..<maxDepth {
            let normalized = (current.path as NSString).standardizingPath
            directories.append(normalized)

            let parent = current.deletingLastPathComponent()
            if parent.path == current.path {
                break
            }
            current = parent
        }

        return directories
    }

    private func isAgentVaultProjectRoot(_ path: String) -> Bool {
        let resolved = (path as NSString).standardizingPath
        let packageJSON = (resolved as NSString).appendingPathComponent("package.json")
        let sourceCLI = (resolved as NSString).appendingPathComponent("cli/index.ts")
        let builtCLI = (resolved as NSString).appendingPathComponent("dist-cli/index.js")

        let hasCLI = FileManager.default.fileExists(atPath: sourceCLI) ||
            FileManager.default.fileExists(atPath: builtCLI)

        guard hasCLI,
              FileManager.default.fileExists(atPath: packageJSON),
              let data = FileManager.default.contents(atPath: packageJSON),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = json["name"] as? String else {
            return false
        }

        return name.lowercased().contains("agentvault")
    }

    /// Discover the AgentVault project root directory
    func findProjectRoot() -> String? {
        if let cached = projectRoot {
            let resolved = (cached as NSString).standardizingPath
            if isAgentVaultProjectRoot(resolved) {
                projectRoot = resolved
                return resolved
            }
            projectRoot = nil
        }

        var candidates: [String] = []
        var seen = Set<String>()

        func addCandidate(_ rawPath: String?, includeParents: Bool = true) {
            guard let rawPath, !rawPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return
            }

            let expanded = (rawPath as NSString).expandingTildeInPath
            let paths = includeParents ? parentDirectories(of: expanded) : [expanded]

            for path in paths {
                let resolved = (path as NSString).standardizingPath
                if seen.insert(resolved).inserted {
                    candidates.append(resolved)
                }
            }
        }

        // Explicit environment overrides.
        addCandidate(ProcessInfo.processInfo.environment["AGENTVAULT_ROOT"])
        addCandidate(ProcessInfo.processInfo.environment["AGENTVAULT_DIR"])

        // Current process working directory and parents (important in local dev).
        addCandidate(FileManager.default.currentDirectoryPath)

        // Relative to app bundle.
        addCandidate(Bundle.main.bundlePath)
        addCandidate(Bundle.main.bundleURL.deletingLastPathComponent().path)

        // Common local development locations.
        let home = NSHomeDirectory()
        let commonBases = [
            home,
            home + "/Desktop",
            home + "/Desktop/Repos",
            home + "/Developer",
            home + "/Developer/Repos",
            home + "/Projects",
            home + "/Code",
            "/usr/local/src",
        ]

        for base in commonBases {
            addCandidate((base as NSString).appendingPathComponent("AgentVault"), includeParents: false)
        }

        for candidate in candidates {
            if isAgentVaultProjectRoot(candidate) {
                projectRoot = candidate
                return candidate
            }
        }

        return nil
    }

    /// Set the project root manually (from Settings)
    func setProjectRoot(_ path: String) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            projectRoot = nil
            return
        }
        projectRoot = (trimmed as NSString).expandingTildeInPath
    }

    // MARK: - Environment Checks

    func checkEnvironment() async -> EnvironmentStatus {
        var status = EnvironmentStatus()

        // Check Node.js
        if let result = try? await run("node", args: ["--version"]) {
            status.nodeInstalled = true
            status.nodeVersion = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Check npm
        if let _ = try? await run("npm", args: ["--version"]) {
            status.npmInstalled = true
        }

        // Check AgentVault CLI
        if let root = findProjectRoot() {
            let sourceCLI = (root as NSString).appendingPathComponent("cli/index.ts")
            let builtCLI = (root as NSString).appendingPathComponent("dist-cli/index.js")
            status.agentVaultInstalled = FileManager.default.fileExists(atPath: sourceCLI) ||
                FileManager.default.fileExists(atPath: builtCLI)
            if status.agentVaultInstalled {
                status.agentVaultVersion = "local"
            }
        }

        return status
    }

    // MARK: - Wallet Operations

    /// Generate a new wallet for the given chain
    func generateWallet(chain: Chain, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "generate", "--chain", chain.rawValue.lowercased(), "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a mnemonic phrase
    func importFromMnemonic(chain: Chain, mnemonic: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", chain.rawValue.lowercased(),
                   "--mnemonic", mnemonic, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a private key
    func importFromPrivateKey(chain: Chain, privateKey: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", chain.rawValue.lowercased(),
                   "--private-key", privateKey, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a JWK file (Arweave)
    func importFromJWK(filePath: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "ar", "--jwk-file", filePath, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .arweave)
    }

    /// Import from PEM file (ICP)
    func importFromPEM(filePath: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "icp", "--pem-file", filePath, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .icp)
    }

    /// Import from keystore JSON (Ethereum)
    func importFromKeystore(filePath: String, password: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "eth", "--keystore", filePath,
                   "--password", password, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .ethereum)
    }

    /// Get wallet balance
    func getBalance(chain: Chain, address: String) async throws -> String {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "balance", "--chain", chain.rawValue.lowercased(), "--address", address, "--json"]
        )

        if let data = output.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let balance = json["balance"] as? String {
            return balance
        }

        // Fallback: try to extract balance from plain text
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return "0"
    }

    /// Export wallet data
    func exportWallet(walletId: String, format: String, outputPath: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["wallet-export", "--id", walletId, "--format", format, "--output", outputPath, "--json"]
        )
    }

    /// Create a backup of all wallets
    func createBackup(outputPath: String, password: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["backup", "create", "--output", outputPath, "--password", password, "--json"]
        )
    }

    /// Restore wallets from a backup
    func restoreBackup(inputPath: String, password: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["backup", "restore", "--input", inputPath, "--password", password, "--json"]
        )
    }

    // MARK: - Process Execution

    private func requireProjectRoot() throws -> String {
        guard let root = findProjectRoot() else {
            throw CLIError.cliNotFound
        }
        return root
    }

    /// Run the AgentVault CLI via tsx
    private func runCLI(root: String, args: [String]) async throws -> String {
        let sourceCLI = (root as NSString).appendingPathComponent("cli/index.ts")
        let builtCLI = (root as NSString).appendingPathComponent("dist-cli/index.js")
        let tsxPath = (root as NSString).appendingPathComponent("node_modules/.bin/tsx")

        let command: String
        let fullArgs: [String]

        if FileManager.default.fileExists(atPath: sourceCLI) {
            if FileManager.default.fileExists(atPath: tsxPath) {
                command = tsxPath
                fullArgs = [sourceCLI] + args
            } else {
                // Fallback: use npx tsx
                command = "npx"
                fullArgs = ["tsx", sourceCLI] + args
            }
        } else if FileManager.default.fileExists(atPath: builtCLI) {
            command = "node"
            fullArgs = [builtCLI] + args
        } else {
            throw CLIError.cliNotFound
        }

        return try await run(command, args: fullArgs, cwd: root)
    }

    /// Execute a process and capture its stdout
    @discardableResult
    private func run(_ command: String, args: [String] = [], cwd: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()

            // Resolve command path
            if command.hasPrefix("/") || command.hasPrefix(".") {
                process.executableURL = URL(fileURLWithPath: command)
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = [command] + args
            }

            if process.executableURL?.lastPathComponent != "env" {
                process.arguments = args
            }

            if let cwd = cwd {
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            }

            // Inherit PATH from user environment
            var env = ProcessInfo.processInfo.environment
            let additionalPaths = [
                "/usr/local/bin",
                "/opt/homebrew/bin",
                NSHomeDirectory() + "/.nvm/versions/node/current/bin",
                NSHomeDirectory() + "/.volta/bin",
                NSHomeDirectory() + "/.fnm/current/bin",
            ]
            let currentPath = env["PATH"] ?? "/usr/bin:/bin"
            env["PATH"] = (additionalPaths + [currentPath]).joined(separator: ":")
            process.environment = env

            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            process.terminationHandler = { proc in
                let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
                let stderr = String(data: stderrData, encoding: .utf8) ?? ""

                if proc.terminationStatus == 0 {
                    continuation.resume(returning: stdout)
                } else {
                    let combined = [stderr, stdout]
                        .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                        .joined(separator: "\n")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    let message = combined.isEmpty
                        ? "Process exited with status \(proc.terminationStatus)"
                        : combined
                    continuation.resume(throwing: CLIError.commandFailed(message))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: CLIError.commandFailed(error.localizedDescription))
            }
        }
    }

    // MARK: - Parsing

    private func parseJSONObject(from output: String) -> [String: Any]? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)

        if let data = trimmed.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return json
        }

        for line in output.components(separatedBy: .newlines) {
            let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if candidate.first == "{", candidate.last == "}",
               let data = candidate.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
        }

        if let start = output.firstIndex(of: "{"),
           let end = output.lastIndex(of: "}"),
           start <= end {
            let snippet = String(output[start...end])
            if let data = snippet.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
        }

        return nil
    }

    private func parseCLIWalletResult(_ output: String, chain: Chain) throws -> CLIWalletResult {
        // Try JSON parse first
        if let json = parseJSONObject(from: output) {
            var address = json["address"] as? String
            if address == nil {
                address = json["principal"] as? String
            }
            if address == nil, let wallet = json["wallet"] as? [String: Any] {
                address = wallet["address"] as? String ?? wallet["principal"] as? String
            }

            return CLIWalletResult(
                address: address ?? "",
                mnemonic: json["mnemonic"] as? String,
                privateKey: json["privateKey"] as? String,
                publicKey: json["publicKey"] as? String,
                chain: chain
            )
        }

        // Fallback: parse text output
        var address = ""
        var mnemonic: String?
        var privateKey: String?

        for line in output.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.lowercased().contains("address:") || trimmed.lowercased().contains("principal:") {
                address = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            } else if trimmed.lowercased().contains("mnemonic:") {
                mnemonic = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            } else if trimmed.lowercased().contains("private") && trimmed.contains(":") {
                privateKey = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            }
        }

        // Final fallback: extract an Ethereum-style address from mixed output.
        if address.isEmpty,
           let regex = try? NSRegularExpression(pattern: "0x[a-fA-F0-9]{40}"),
           let match = regex.firstMatch(
                in: output,
                range: NSRange(output.startIndex..<output.endIndex, in: output)
           ),
           let range = Range(match.range, in: output) {
            address = String(output[range])
        }

        guard !address.isEmpty else {
            throw CLIError.parseError("Could not extract wallet address from CLI output")
        }

        return CLIWalletResult(
            address: address,
            mnemonic: mnemonic,
            privateKey: privateKey,
            publicKey: nil,
            chain: chain
        )
    }
}

/// Parsed result from CLI wallet operations
struct CLIWalletResult {
    let address: String
    let mnemonic: String?
    let privateKey: String?
    let publicKey: String?
    let chain: Chain
}
