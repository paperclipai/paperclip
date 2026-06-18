# Creating a Company From an Existing Repository

When a user provides a git repo (URL, local path, or tweet linking to a repo), analyze it and create a company package that wraps its content.

## Analysis Steps

1. **Clone or read the repo** - Use `git clone` for URLs, read directly for local paths
2. **Scan for existing agent/skill files** - Look for SKILL.md, AGENTS.md, CLAUDE.md, .claude/ directories, or similar agent configuration
3. **Understand the repo's purpose** - Read README, package.json, main source files to understand what the project does
4. **Identify natural agent roles** - Based on the repo's structure and purpose, determine what agents would be useful

## Handling Existing Skills

Many repos already contain skills (SKILL.md files). When you find them:

**Default behavior: use references, not copies.**

Instead of copying skill content into your company package, create a source reference:

```yaml
metadata:
  sources:
    - kind: github-file
      repo: owner/repo
      path: path/to/SKILL.md
      commit: <get the current HEAD commit SHA>
      attribution: <repo owner or org name>
      license: <from repo's LICENSE file>
      usage: referenced
```

To get the commit SHA:
```bash
git ls-remote https://github.com/owner/repo HEAD
```

Only vendor (copy) skills when:
- The user explicitly asks to copy them
- The skill is very small and tightly coupled to the company
- The source repo is private or may become unavailable

## Handling Existing Agent Configurations

If the repo has agent configs (CLAUDE.md, .claude/ directories, codex configs, etc.):
- Use them as inspiration for AGENTS.md instructions
- Don't copy them verbatim - adapt them to the Agent Companies format
- Preserve the intent and key instructions

## Repo-Only Skills (No Agents)

When a repo contains only skills and no agents:
- Create agents that would naturally use those skills
- The agents should be minimal - just enough to give the skills a runtime context
- A single agent may use multiple skills from the repo
- Name agents based on the domain the skills cover

Example: A repo with `code-review`, `testing`, and `deployment` skills might become:
- A "Lead Engineer" agent with all three skills
- Or separate "Reviewer", "QA Engineer", and "DevOps" agents if the skills are distinct enough

## Common Repo Patterns

### Developer Tools / CLI repos
- Create agents for the tool's primary use cases
- Reference any existing skills
- Add a project maintainer or lead agent

### Library / Framework repos
- Create agents for development, testing, documentation
- Skills from the repo become agent capabilities

### Full Application repos
- Map to departments: engineering, product, QA
- Create a lean team structure appropriate to the project size

### Skills Collection repos (e.g. skills.sh repos)
- Each skill or skill group gets an agent
- Create a lightweight company or team wrapper
- Keep the agent count proportional to the skill diversity
