#!/bin/bash
# Bob Shell MCP Connection Diagnostic Script
# Usage: ./diagnose-mcp.sh [workspace_path]

set -e

WORKSPACE="${1:-$(pwd)}"
echo "=== Bob Shell MCP Connection Diagnostics ==="
echo "Workspace: $WORKSPACE"
echo ""

# Check 1: Bob Shell installation
echo "1. Checking Bob Shell installation..."
if command -v bob &> /dev/null; then
    BOB_VERSION=$(bob --version 2>&1 | grep -v "DeprecationWarning" | head -1)
    echo "   ✓ Bob Shell found: $BOB_VERSION"
else
    echo "   ✗ Bob Shell not found in PATH"
    exit 1
fi
echo ""

# Check 2: MCP server package availability
echo "2. Checking @paperclipai/mcp-server package..."
if npm view @paperclipai/mcp-server version &> /dev/null; then
    MCP_VERSION=$(npm view @paperclipai/mcp-server version 2>&1 | grep -v "warn")
    echo "   ✓ Package available: v$MCP_VERSION"
else
    echo "   ✗ Package not found in npm registry"
    exit 1
fi
echo ""

# Check 3: Workspace .bob directory
echo "3. Checking workspace .bob directory..."
if [ -d "$WORKSPACE/.bob" ]; then
    echo "   ✓ .bob directory exists"
    
    if [ -f "$WORKSPACE/.bob/mcp.json" ]; then
        echo "   ✓ mcp.json exists"
        echo ""
        echo "   Content:"
        cat "$WORKSPACE/.bob/mcp.json" | sed 's/^/     /'
    else
        echo "   ✗ mcp.json not found"
        echo "   Expected: $WORKSPACE/.bob/mcp.json"
    fi
    
    if [ -f "$WORKSPACE/.bob/custom_modes.yaml" ]; then
        echo "   ✓ custom_modes.yaml exists"
    else
        echo "   ⚠ custom_modes.yaml not found (may be optional)"
    fi
else
    echo "   ✗ .bob directory not found"
    echo "   Expected: $WORKSPACE/.bob"
fi
echo ""

# Check 4: Bob Shell MCP detection
echo "4. Testing Bob Shell MCP server detection..."
cd "$WORKSPACE"
MCP_LIST_OUTPUT=$(bob mcp list 2>&1 | grep -v "DeprecationWarning" || true)
if echo "$MCP_LIST_OUTPUT" | grep -q "paperclip"; then
    echo "   ✓ Paperclip MCP server detected"
    if echo "$MCP_LIST_OUTPUT" | grep -q "Connected"; then
        echo "   ✓ Connection status: Connected"
    else
        echo "   ⚠ Connection status: Not connected"
        echo "   Output:"
        echo "$MCP_LIST_OUTPUT" | sed 's/^/     /'
    fi
else
    echo "   ✗ Paperclip MCP server not detected"
    echo "   Output:"
    echo "$MCP_LIST_OUTPUT" | sed 's/^/     /'
fi
echo ""

# Check 5: Environment variables in mcp.json
echo "5. Checking MCP server environment variables..."
if [ -f "$WORKSPACE/.bob/mcp.json" ]; then
    API_URL=$(jq -r '.mcpServers.paperclip.env.PAPERCLIP_API_URL // empty' "$WORKSPACE/.bob/mcp.json" 2>/dev/null || echo "")
    API_KEY=$(jq -r '.mcpServers.paperclip.env.PAPERCLIP_API_KEY // empty' "$WORKSPACE/.bob/mcp.json" 2>/dev/null || echo "")
    COMPANY_ID=$(jq -r '.mcpServers.paperclip.env.PAPERCLIP_COMPANY_ID // empty' "$WORKSPACE/.bob/mcp.json" 2>/dev/null || echo "")
    AGENT_ID=$(jq -r '.mcpServers.paperclip.env.PAPERCLIP_AGENT_ID // empty' "$WORKSPACE/.bob/mcp.json" 2>/dev/null || echo "")
    
    if [ -n "$API_URL" ]; then
        echo "   ✓ PAPERCLIP_API_URL: $API_URL"
    else
        echo "   ✗ PAPERCLIP_API_URL: not set"
    fi
    
    if [ -n "$API_KEY" ]; then
        echo "   ✓ PAPERCLIP_API_KEY: ***${API_KEY: -4}"
    else
        echo "   ✗ PAPERCLIP_API_KEY: not set"
    fi
    
    if [ -n "$COMPANY_ID" ]; then
        echo "   ✓ PAPERCLIP_COMPANY_ID: $COMPANY_ID"
    else
        echo "   ⚠ PAPERCLIP_COMPANY_ID: not set (optional)"
    fi
    
    if [ -n "$AGENT_ID" ]; then
        echo "   ✓ PAPERCLIP_AGENT_ID: $AGENT_ID"
    else
        echo "   ⚠ PAPERCLIP_AGENT_ID: not set (optional)"
    fi
else
    echo "   ✗ Cannot check: mcp.json not found"
fi
echo ""

# Check 6: Paperclip API connectivity
echo "6. Testing Paperclip API connectivity..."
if [ -n "$API_URL" ]; then
    HEALTH_URL="${API_URL}/health"
    if curl -s -f -m 5 "$HEALTH_URL" > /dev/null 2>&1; then
        echo "   ✓ API accessible: $HEALTH_URL"
    else
        echo "   ✗ API not accessible: $HEALTH_URL"
        echo "   Ensure Paperclip server is running"
    fi
else
    echo "   ⚠ Skipped: API_URL not configured"
fi
echo ""

# Check 7: MCP server manual test
echo "7. Testing MCP server manually..."
if [ -n "$API_URL" ] && [ -n "$API_KEY" ]; then
    echo "   Running: npx -y @paperclipai/mcp-server (5 second timeout)"
    PAPERCLIP_API_URL="$API_URL" \
    PAPERCLIP_API_KEY="$API_KEY" \
    PAPERCLIP_COMPANY_ID="${COMPANY_ID:-test}" \
    PAPERCLIP_AGENT_ID="${AGENT_ID:-test}" \
    PAPERCLIP_RUN_ID="diagnostic-test" \
    timeout 5 npx -y @paperclipai/mcp-server 2>&1 | head -20 || true
    echo "   (Process terminated after 5 seconds - this is expected)"
else
    echo "   ⚠ Skipped: Missing API_URL or API_KEY"
fi
echo ""

# Summary
echo "=== Diagnostic Summary ==="
echo ""
echo "Common Issues:"
echo "  1. Missing .bob/mcp.json → Run Paperclip agent to trigger workspace sync"
echo "  2. MCP server not detected → Check Bob Shell can read .bob/mcp.json"
echo "  3. Connection failed → Verify PAPERCLIP_API_URL and PAPERCLIP_API_KEY"
echo "  4. API not accessible → Ensure Paperclip server is running"
echo ""
echo "Next Steps:"
echo "  - Review DEBUG.md for detailed troubleshooting"
echo "  - Check Paperclip agent logs for workspace sync messages"
echo "  - Try: cd $WORKSPACE && bob --chat-mode paperclip-agent"
echo ""
