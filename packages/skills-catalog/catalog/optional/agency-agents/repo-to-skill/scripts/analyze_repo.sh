#!/usr/bin/env bash
# Analyze a GitHub repo and extract key information for skill generation
# Usage: analyze_repo.sh <repo-url> [output-dir]

set -euo pipefail

REPO_URL="${1:?Usage: analyze_repo.sh <repo-url> [output-dir]}"
OUTPUT_DIR="${2:-/tmp/repo-to-skill}"
REPO_NAME=$(basename "$REPO_URL" .git)
CLONE_DIR="$OUTPUT_DIR/$REPO_NAME"

echo "=== Repo-to-Skill Analyzer ==="
echo "Repo: $REPO_URL"
echo "Clone dir: $CLONE_DIR"

# Clone (shallow)
if [ -d "$CLONE_DIR" ]; then
    echo "Already cloned, pulling latest..."
    cd "$CLONE_DIR" && git pull --depth 1 2>/dev/null || true
else
    echo "Cloning..."
    git clone --depth 1 "$REPO_URL" "$CLONE_DIR"
fi

cd "$CLONE_DIR"

echo ""
echo "=== Structure ==="
# Show top-level structure
find . -maxdepth 2 -type f \( -name "*.md" -o -name "*.rst" -o -name "*.txt" -o -name "setup.py" -o -name "pyproject.toml" -o -name "package.json" -o -name "Cargo.toml" -o -name "Makefile" -o -name "Dockerfile" \) | head -30

echo ""
echo "=== Language Detection ==="
# Detect primary language
if [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "setup.cfg" ]; then
    echo "Python project"
    [ -f "pyproject.toml" ] && echo "  Build: pyproject.toml"
    [ -f "setup.py" ] && echo "  Build: setup.py"
fi
if [ -f "package.json" ]; then
    echo "Node.js project"
    jq -r '.name // "unknown", .description // "no description"' package.json 2>/dev/null
fi
if [ -f "Cargo.toml" ]; then
    echo "Rust project"
    grep -E "^name|^description" Cargo.toml | head -5
fi
if [ -f "go.mod" ]; then
    echo "Go project"
    head -1 go.mod
fi

echo ""
echo "=== README (first 200 lines) ==="
if [ -f "README.md" ]; then
    head -200 README.md
elif [ -f "readme.md" ]; then
    head -200 readme.md
elif [ -f "README.rst" ]; then
    head -200 README.rst
else
    echo "No README found"
fi

echo ""
echo "=== Docs Directory ==="
for d in docs documentation doc; do
    if [ -d "$d" ]; then
        echo "Found: $d/"
        find "$d" -name "*.md" -o -name "*.rst" | head -20
    fi
done

echo ""
echo "=== Examples Directory ==="
for d in examples example demos; do
    if [ -d "$d" ]; then
        echo "Found: $d/"
        find "$d" -maxdepth 2 -type f | head -20
    fi
done

echo ""
echo "=== Entry Points ==="
# Python entry points
if [ -f "pyproject.toml" ]; then
    grep -A10 "\[project.scripts\]" pyproject.toml 2>/dev/null || true
    grep -A10 "\[tool.poetry.scripts\]" pyproject.toml 2>/dev/null || true
fi
if [ -f "setup.py" ]; then
    grep -E "console_scripts|entry_points" setup.py 2>/dev/null || true
fi
# Node entry points
if [ -f "package.json" ]; then
    jq '.bin // empty' package.json 2>/dev/null || true
fi

echo ""
echo "=== Analysis complete ==="
echo "Clone available at: $CLONE_DIR"
