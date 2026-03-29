// Promptfoo custom script provider using Claude Code CLI.
const { execFileSync } = require('child_process');

class ClaudeCliProvider {
  constructor() {
    this.providerId = 'claude-code-local';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const claudePath = process.env.CLAUDE_BIN || 'claude';
      const output = execFileSync(claudePath, ['--print', '--model', 'sonnet', '--permission-mode', 'plan'], {
        input: prompt,
        encoding: 'utf-8',
        timeout: 180_000,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      return { output };
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = ClaudeCliProvider;
