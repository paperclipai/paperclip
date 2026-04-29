import { Command } from "commander";
import pc from "picocolors";

// We use __DOLLAR__ as a placeholder for $ to avoid TypeScript template
// literal interpolation on shell variable syntax like ${words[i]}.

const BASH_TEMPLATE = `#!/usr/bin/env bash
# Paperclip CLI (paperclipai) shell completion for Bash
# Generated automatically — do not edit manually

_paperclipai_completion() {
  local cur prev words cword
  _init_completion || return

  # Build the command path by extracting only non-option, non-argument words
  local cmd_words=()
  for ((i=1; i<cword; i++)); do
    local w="__DOLLAR__{words[i]}"
    [[ "$w" == -* ]] && continue
    [[ -n "__DOLLAR__{cur}" && $i -eq $((cword-1)) && "$w" == "$prev" ]] && continue
    cmd_words+=("$w")
  done

  local cmd_path="__DOLLAR__{cmd_words[*]}"
  [[ -z "$cmd_path" ]] && cmd_path="paperclipai"

  # Ask the CLI for completions
  local suggestions
  suggestions=$(paperclipai __complete "$cmd_path" "$cur" 2>/dev/null)
  [[ -z "$suggestions" ]] && return

  COMPREPLY=($(compgen -W "$suggestions" -- "$cur"))
}

complete -F _paperclipai_completion paperclipai
`.replace(/__DOLLAR__/g, "$");

const ZSH_TEMPLATE = `#compdef paperclipai
# Paperclip CLI (paperclipai) shell completion for Zsh
# Generated automatically — do not edit manually

_paperclipai() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  # Build command path from words
  local cmd_words=()
  local i
  for ((i=2; i<=CURRENT; i++)); do
    local w="__DOLLAR__{words[i]}"
    [[ "$w" == -* ]] && continue
    cmd_words+=("$w")
  done

  local cmd_path="__DOLLAR__{cmd_words[*]}"
  [[ -z "$cmd_path" ]] && cmd_path="paperclipai"

  local suggestions
  suggestions=(__DOLLAR__{(s: :)$(paperclipai __complete "$cmd_path" "$words[CURRENT]" 2>/dev/null)})

  if [[ __DOLLAR__{#suggestions} -gt 0 ]]; then
    _describe -t commands 'paperclipai completions' suggestions
  fi
}

compdef _paperclipai paperclipai
`.replace(/__DOLLAR__/g, "$");

const FISH_TEMPLATE = `# Paperclip CLI (paperclipai) shell completion for Fish
# Generated automatically — do not edit manually

function __paperclipai_complete
  set -l cmd_words
  for w in (commandline -opc)
    if not string match -q '--*' $w; and not string match -q '-*' $w
      set cmd_words $cmd_words $w
    end
  end
  set -l cmd_path (string join ' ' $cmd_words)
  test -z "$cmd_path"; and set cmd_path "paperclipai"
  paperclipai __complete "$cmd_path" (commandline -ct) 2>/dev/null
end

complete -c paperclipai -f -a "(__paperclipai_complete)"
`;

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Generate shell completion script")
    .argument("<shell>", "Shell type: bash, zsh, or fish")
    .action((shell: string) => {
      const normalized = shell.toLowerCase().trim();

      switch (normalized) {
        case "bash":
          console.log(BASH_TEMPLATE.trim());
          break;
        case "zsh":
          console.log(ZSH_TEMPLATE.trim());
          break;
        case "fish":
          console.log(FISH_TEMPLATE.trim());
          break;
        default:
          console.error(pc.red(`Unknown shell: ${shell}. Supported: bash, zsh, fish`));
          process.exit(1);
      }
    });
}

/**
 * Register the hidden __complete command used by shell completion scripts.
 * This command takes a command path and current word, then prints matching
 * commands, options, and arguments.
 */
export function registerHiddenCompletionCommand(program: Command): void {
  program
    .command("__complete")
    .description("Internal command for shell completion (do not use directly)")
    .argument("<commandPath>", "Full command path (e.g. 'paperclipai issue')")
    .argument("<currentWord>", "The word being completed")
    .allowUnknownOption()
    .action((commandPath: string, currentWord: string) => {
      const suggestions = generateCompletions(program, commandPath, currentWord);
      if (suggestions.length > 0) {
        console.log(suggestions.join(" "));
      }
    });
}

function generateCompletions(
  root: Command,
  commandPath: string,
  currentWord: string,
): string[] {
  const parts = commandPath.split(/\s+/).filter((p) => p !== "paperclipai" && p.length > 0);

  // Navigate to the target command
  let target = root;
  for (const part of parts) {
    const sub = target.commands.find((c) => c.name() === part || c.aliases().includes(part));
    if (!sub) {
      // Unknown subcommand — no completions
      return [];
    }
    target = sub;
  }

  const results = new Set<string>();

  // If current word starts with "-", complete options
  if (currentWord.startsWith("-")) {
    for (const opt of target.options) {
      const flags = opt.flags.split(/[,\s]+/);
      for (const flag of flags) {
        const trimmed = flag.trim();
        if (trimmed.startsWith("-") && trimmed.startsWith(currentWord)) {
          results.add(trimmed);
        }
      }
    }
    return Array.from(results);
  }

  // Otherwise complete subcommands
  for (const cmd of target.commands) {
    const name = cmd.name();
    if (name.startsWith(currentWord) && !name.startsWith("__")) {
      results.add(name);
    }
    for (const alias of cmd.aliases()) {
      if (alias.startsWith(currentWord) && !alias.startsWith("__")) {
        results.add(alias);
      }
    }
  }

  return Array.from(results);
}
