---
name: "source-command-spartan-update"
description: "Check for updates and upgrade Spartan AI Toolkit to the latest version. Pulls from GitHub and re-runs the setup script automatically."
key: "paperclipai/optional/agency-agents/source-command-spartan-update"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "source"
  - "command"
  - "spartan"
  - "update"
defaultInstall: false
---
# source-command-spartan-update

Use this skill when the user asks to run the migrated source command `spartan-update`.

## Command Template

# Spartan Update

Check for new versions and upgrade the toolkit.

---

## Step 1: Read current version and repo path

```bash
LOCAL_VER=$(cat ~/.Codex/.spartan-version 2>/dev/null || echo "unknown")
REPO_PATH=$(cat ~/.Codex/.spartan-repo 2>/dev/null || echo "")
echo "Current version: $LOCAL_VER"
echo "Repo path: $REPO_PATH"
```

If `REPO_PATH` is empty or the directory doesn't exist, try to find it:

```bash
# Common locations
for dir in ~/ai-toolkit ~/Documents/Code/Spartan/ai-toolkit ~/Code/ai-toolkit; do
  [ -d "$dir/toolkit" ] && echo "Found: $dir" && break
done
```

If still not found, ask the user: "Where did you clone ai-toolkit?"

---

## Step 2: Detect default branch and check for updates

```bash
cd "$REPO_PATH"

# Detect the default branch (master or main)
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$DEFAULT_BRANCH" ]; then
  # Fallback: check which branch exists
  git rev-parse --verify origin/master >/dev/null 2>&1 && DEFAULT_BRANCH="master" || DEFAULT_BRANCH="main"
fi
echo "Default branch: $DEFAULT_BRANCH"

git fetch origin "$DEFAULT_BRANCH" --quiet 2>/dev/null
REMOTE_VER=$(git show "origin/$DEFAULT_BRANCH:toolkit/VERSION" 2>/dev/null || echo "unknown")
echo "Local:  $LOCAL_VER"
echo "Remote: $REMOTE_VER"
```

If versions match: "You're on the latest version (v$LOCAL_VER). No update needed."

If versions differ or either is "unknown": proceed to Step 3.

---

## Step 3: Read current pack selection

```bash
SAVED_PACKS=$(cat ~/.Codex/.spartan-packs 2>/dev/null | tr '\n' ',' | sed 's/,$//')
echo "Installed packs: $SAVED_PACKS"
```

Show the user their current packs and ask:
"You have these packs: $SAVED_PACKS. Want to keep the same packs, or change them?"

- Keep same → use `--packs=$SAVED_PACKS` flag
- Change → run without `--packs` flag (interactive menu)

---

## Step 4: Pull and reinstall

```bash
cd "$REPO_PATH" && git pull origin "$DEFAULT_BRANCH"
```

Then run the setup script with saved packs:

```bash
cd "$REPO_PATH/toolkit" && ./scripts/setup.sh --global --packs=$SAVED_PACKS
```

Or if user wants to change packs:

```bash
cd "$REPO_PATH/toolkit" && ./scripts/setup.sh --global
```

---

## Step 4.5: Generate config if missing

After the install finishes, check if `.spartan/config.yaml` exists:

```bash
ls .spartan/config.yaml 2>/dev/null || ls ~/.spartan/config.yaml 2>/dev/null
```

**If no config exists**, generate one from the installed packs:

1. Read the saved packs file:
```bash
cat ~/.Codex/.spartan-packs 2>/dev/null || cat .Codex/.spartan-packs 2>/dev/null
```

2. Pick the matching profile:
   - Has `backend-micronaut` → copy `toolkit/profiles/kotlin-micronaut.yaml`
   - Has `frontend-react` → copy `toolkit/profiles/react-nextjs.yaml`
   - Has `backend-nodejs` → copy `toolkit/profiles/typescript-node.yaml`
   - Has `backend-python` → copy `toolkit/profiles/python-fastapi.yaml`
   - None of the above → copy `toolkit/profiles/custom.yaml`

3. Copy the profile:
```bash
mkdir -p .spartan 2>/dev/null || mkdir -p ~/.spartan
cp "$REPO_PATH/toolkit/profiles/{profile}.yaml" .spartan/config.yaml 2>/dev/null || \
cp "$REPO_PATH/toolkit/profiles/{profile}.yaml" ~/.spartan/config.yaml
```

Tell the user: "Generated `.spartan/config.yaml` from {profile} profile. Edit it to customize rules and review stages."

**If config already exists**, skip this step.

---

## Step 4.6: Refresh update cache

Clear the update cache so the statusline refreshes on next session:

```bash
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.Codex}"
rm -f "$CLAUDE_DIR/cache/spartan-update-check.json"
```

---

## Step 5: Confirm

After setup completes, tell the user:
"Updated to Spartan v$REMOTE_VER. Restart Codex to pick up all changes."
