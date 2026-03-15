import { spawn } from 'node:child_process';
export async function execCapture(file, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const runOnce = (executable) => new Promise((resolve) => {
        // Keep this very small + predictable:
        // - no shell by default (avoid quoting differences)
        // - capture stdout/stderr for diagnostics
        // - hard timeout so keychain/keyring calls can't hang forever in CI/SSH sessions
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                // ignore
            }
            resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
        }, timeoutMs);
        timer.unref?.();
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({
                code: 127,
                stdout,
                stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
            });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
    const result = await runOnce(file);
    if (process.platform !== 'win32')
        return result;
    /* c8 ignore start */
    const runOnceCmd = (cmd) => {
        // On Windows, some tools are `.cmd`/`.bat` wrappers and won't exec directly.
        // We fall back to `cmd.exe /c` and quote args ourselves.
        const quoted = [cmd, ...args.map(cmdQuote)].join(' ');
        return new Promise((resolve) => {
            const child = spawn('cmd.exe', ['/d', '/s', '/c', quoted], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
            });
            const timer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // ignore
                }
                resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
            }, timeoutMs);
            timer.unref?.();
            child.on('error', (error) => {
                clearTimeout(timer);
                resolve({
                    code: 127,
                    stdout,
                    stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
                });
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve({ code: code ?? 0, stdout, stderr });
            });
        });
    };
    const stderr = result.stderr.toLowerCase();
    if (result.code === 127 && stderr.includes('enoent') && !file.toLowerCase().endsWith('.cmd')) {
        const cmdResult = await runOnceCmd(`${file}.cmd`);
        if (!(cmdResult.code === 127 && cmdResult.stderr.toLowerCase().includes('enoent')))
            return cmdResult;
    }
    if (result.code === 127 && stderr.includes('enoent') && !file.toLowerCase().endsWith('.bat')) {
        const batResult = await runOnceCmd(`${file}.bat`);
        if (!(batResult.code === 127 && batResult.stderr.toLowerCase().includes('enoent')))
            return batResult;
    }
    /* c8 ignore stop */
    return result;
}
function cmdQuote(value) {
    if (!value)
        return '""';
    if (!/[\t\s"&|<>^]/.test(value))
        return value;
    return `"${value.replaceAll('"', '""')}"`;
}
//# sourceMappingURL=exec.js.map