import Foundation
import NeurOSAppCore

public actor LocalPaperclipServerManager: LocalServerControlling {
    private struct LaunchPlan: Sendable {
        let command: String
        let displayCommand: String
        let workingDirectory: String?
        let resolutionSummary: String
    }

    private let fileManager: FileManager
    private let maxOutputLines = 40

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var phase: LocalServerPhase = .idle
    private var recentOutput: [String] = []
    private var lastStartedAt: Date?
    private var lastExitAt: Date?
    private var lastExitCode: Int32?
    private var lastDetail: String = "Servidor local pronto para iniciar."
    private var lastResolvedCommand: String?
    private var lastResolvedWorkingDirectory: String?
    private var stopRequested = false

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    public func currentStatus(configuration: ServerConnectionConfiguration) async -> LocalServerStatus {
        if let process, process.isRunning == false {
            await handleTermination(exitCode: process.terminationStatus)
        }

        let plan = resolveLaunchPlan(configuration: configuration)
        let resolvedCommand = plan?.displayCommand ?? lastResolvedCommand
        let resolvedWorkingDirectory = plan?.workingDirectory ?? lastResolvedWorkingDirectory
        let detail: String
        if process != nil || phase != .idle || recentOutput.isEmpty == false {
            detail = lastDetail
        } else {
            detail = plan?.resolutionSummary ?? lastDetail
        }

        return LocalServerStatus(
            phase: phase,
            isManagedProcess: process != nil,
            resolvedCommand: resolvedCommand,
            resolvedWorkingDirectory: resolvedWorkingDirectory,
            detail: detail,
            recentOutput: recentOutput,
            launchedAt: lastStartedAt,
            lastExitAt: lastExitAt,
            lastExitCode: lastExitCode,
            pid: process?.processIdentifier
        )
    }

    public func ensureRunning(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus {
        if let process, process.isRunning {
            return await currentStatus(configuration: configuration)
        }
        return try await start(configuration: configuration)
    }

    public func start(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus {
        if let process, process.isRunning {
            return await currentStatus(configuration: configuration)
        }

        guard let plan = resolveLaunchPlan(configuration: configuration) else {
            throw NSError(
                domain: "io.goldneuron.neurOS.local-server",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey: """
                    Não foi possível resolver um comando para iniciar o servidor local. \
                    Configure um caminho de workspace do Paperclip ou um comando customizado.
                    """
                ]
            )
        }

        await cleanupProcessState()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", plan.command]
        if let workingDirectory = plan.workingDirectory {
            process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory, isDirectory: true)
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak stdoutPipe] handle in
            let data = handle.availableData
            guard data.isEmpty == false else {
                stdoutPipe?.fileHandleForReading.readabilityHandler = nil
                return
            }
            let chunk = String(decoding: data, as: UTF8.self)
            Task { await self.appendOutput(chunk) }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak stderrPipe] handle in
            let data = handle.availableData
            guard data.isEmpty == false else {
                stderrPipe?.fileHandleForReading.readabilityHandler = nil
                return
            }
            let chunk = String(decoding: data, as: UTF8.self)
            Task { await self.appendOutput(chunk) }
        }

        process.terminationHandler = { process in
            Task { await self.handleTermination(exitCode: process.terminationStatus) }
        }

        do {
            try process.run()
            self.process = process
            self.stdoutPipe = stdoutPipe
            self.stderrPipe = stderrPipe
            self.phase = .starting
            self.lastStartedAt = .now
            self.lastResolvedCommand = plan.displayCommand
            self.lastResolvedWorkingDirectory = plan.workingDirectory
            self.lastDetail = "Inicializando Paperclip local via \(plan.displayCommand)."
            self.stopRequested = false
            appendOutput("→ \(plan.displayCommand)")
            if let workingDirectory = plan.workingDirectory {
                appendOutput("cwd: \(workingDirectory)")
            }
            return await currentStatus(configuration: configuration)
        } catch {
            self.phase = .failed
            self.lastDetail = "Falha ao iniciar o servidor local."
            self.lastExitCode = nil
            self.lastExitAt = .now
            appendOutput("Falha ao iniciar: \(error.localizedDescription)")
            throw error
        }
    }

    public func restart(configuration: ServerConnectionConfiguration) async throws -> LocalServerStatus {
        _ = await stop()
        return try await start(configuration: configuration)
    }

    public func stop() async -> LocalServerStatus {
        guard let process else {
            lastDetail = "Nenhum processo local gerenciado pelo app."
            return LocalServerStatus(
                phase: phase,
                isManagedProcess: false,
                resolvedCommand: lastResolvedCommand,
                resolvedWorkingDirectory: lastResolvedWorkingDirectory,
                detail: lastDetail,
                recentOutput: recentOutput,
                launchedAt: lastStartedAt,
                lastExitAt: lastExitAt,
                lastExitCode: lastExitCode,
                pid: nil
            )
        }

        stopRequested = true
        appendOutput("Solicitando parada do servidor local...")
        if process.isRunning {
            process.terminate()
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        if process.isRunning {
            process.interrupt()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        if process.isRunning {
            process.terminate()
        }

        return LocalServerStatus(
            phase: phase,
            isManagedProcess: true,
            resolvedCommand: lastResolvedCommand,
            resolvedWorkingDirectory: lastResolvedWorkingDirectory,
            detail: lastDetail,
            recentOutput: recentOutput,
            launchedAt: lastStartedAt,
            lastExitAt: lastExitAt,
            lastExitCode: lastExitCode,
            pid: process.processIdentifier
        )
    }

    public func noteAPIReachable() async {
        guard phase == .starting else { return }
        phase = .running
        lastDetail = "Servidor local conectado e respondendo ao health check."
    }

    private func cleanupProcessState() async {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        process = nil
    }

    private func handleTermination(exitCode: Int32) async {
        let intentionalStop = stopRequested
        stopRequested = false
        await cleanupProcessState()
        lastExitCode = exitCode
        lastExitAt = .now
        if intentionalStop {
            phase = .idle
            lastDetail = "Servidor local parado pelo app."
            appendOutput("Servidor local parado.")
            return
        }
        phase = .failed
        lastDetail = "O processo do servidor local encerrou com código \(exitCode)."
        appendOutput("Processo encerrado com código \(exitCode).")
    }

    private func appendOutput(_ chunk: String) {
        let lines = chunk
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        guard lines.isEmpty == false else { return }
        recentOutput.append(contentsOf: lines)
        if recentOutput.count > maxOutputLines {
            recentOutput.removeFirst(recentOutput.count - maxOutputLines)
        }
        if let lastLine = lines.last {
            lastDetail = lastLine
        }
    }

    private func resolveLaunchPlan(configuration: ServerConnectionConfiguration) -> LaunchPlan? {
        let resolvedWorkspace = resolveWorkspaceRoot(configuration: configuration)
        let trimmedCustomCommand = configuration.localServer.trimmedCustomCommand

        if trimmedCustomCommand.isEmpty == false,
           !(resolvedWorkspace != nil && configuration.localServer.usesLegacyAutoCommand) {
            return LaunchPlan(
                command: trimmedCustomCommand,
                displayCommand: trimmedCustomCommand,
                workingDirectory: resolvedWorkspace,
                resolutionSummary: "Comando customizado configurado para o servidor local."
            )
        }

        if let resolvedWorkspace, isPaperclipWorkspace(at: resolvedWorkspace) {
            return LaunchPlan(
                command: workspaceBootstrapCommand(),
                displayCommand: "auto (pnpm paperclipai run -> node cli/src/index.ts run -> paperclipai run)",
                workingDirectory: resolvedWorkspace,
                resolutionSummary: configuration.localServer.usesLegacyAutoCommand
                    ? "Comando legado salvo foi ignorado e o workspace do monorepo Paperclip será usado automaticamente."
                    : "Workspace do monorepo Paperclip detectado para bootstrap local."
            )
        }

        return LaunchPlan(
            command: "paperclipai run",
            displayCommand: "paperclipai run",
            workingDirectory: resolvedWorkspace,
            resolutionSummary: resolvedWorkspace == nil
                ? "Usando a CLI instalada do Paperclip para iniciar o servidor local."
                : "Usando a CLI instalada do Paperclip com o diretório configurado."
        )
    }

    private func resolveWorkspaceRoot(configuration: ServerConnectionConfiguration) -> String? {
        let trimmedConfiguredPath = configuration.localServer.trimmedWorkspaceRootPath
        if trimmedConfiguredPath.isEmpty == false {
            let expandedPath = NSString(string: trimmedConfiguredPath).expandingTildeInPath
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: expandedPath, isDirectory: &isDirectory), isDirectory.boolValue {
                return expandedPath
            }
        }

        let currentDirectory = fileManager.currentDirectoryPath
        if isPaperclipWorkspace(at: currentDirectory) {
            return currentDirectory
        }

        var candidateURL = Bundle.main.bundleURL.deletingLastPathComponent()
        while candidateURL.path != "/" {
            let candidatePath = candidateURL.path
            if isPaperclipWorkspace(at: candidatePath) {
                return candidatePath
            }
            candidateURL.deleteLastPathComponent()
        }

        return nil
    }

    private func isPaperclipWorkspace(at path: String) -> Bool {
        let packageJSONPath = URL(fileURLWithPath: path, isDirectory: true)
            .appendingPathComponent("package.json")
            .path
        let neurosPath = URL(fileURLWithPath: path, isDirectory: true)
            .appendingPathComponent("apps/neuros-macos/package.json")
            .path

        return fileManager.fileExists(atPath: packageJSONPath) && fileManager.fileExists(atPath: neurosPath)
    }

    private func workspaceBootstrapCommand() -> String {
        """
        export PAPERCLIP_AUTO_ONBOARD=1
        if command -v pnpm >/dev/null 2>&1; then
          exec pnpm paperclipai run
        elif command -v node >/dev/null 2>&1 && [ -f cli/node_modules/tsx/dist/cli.mjs ]; then
          exec node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts run
        elif command -v paperclipai >/dev/null 2>&1; then
          exec paperclipai run
        else
          echo "Nenhum launcher do Paperclip foi encontrado no workspace. Instale as dependências do repo ou configure um comando customizado." >&2
          exit 127
        fi
        """
    }
}
