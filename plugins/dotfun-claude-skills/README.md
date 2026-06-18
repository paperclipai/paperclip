# DotFun Claude Skills Marketplace

This repository can be used as a Claude Code plugin marketplace for DotFun/Paperclip skills.

## Install from the marketplace

Add the marketplace from GitHub:

```text
/plugin marketplace add paperclipai/paperclip
```

Then install the bundled DotFun skills plugin:

```text
/plugin install dotfun-claude-skills@dotfun-claude-skills
```

After install, reload plugins if Claude Code does not pick it up automatically:

```text
/reload-plugins
```

The skills are available under the plugin namespace, for example:

```text
/dotfun-claude-skills:paperclip
/dotfun-claude-skills:company-creator
/dotfun-claude-skills:design-guide
```

## Local development test

From the repository root:

```bash
claude plugin validate .
claude --plugin-dir ./plugins/dotfun-claude-skills
```

Inside Claude Code, run `/reload-plugins` and then try one of the namespaced skills above.

## Structure

```text
.claude-plugin/marketplace.json                 # Claude Code marketplace catalog
plugins/dotfun-claude-skills/.claude-plugin/plugin.json
plugins/dotfun-claude-skills/skills/<skill>/SKILL.md
```

The plugin directory is self-contained: symlinked skills from the legacy `.claude/skills` setup are materialized as real directories so Claude Code's plugin cache can copy them safely.
