#!/bin/bash

# Create Upstash Redis instance for Paperclip
# Usage: UPSTASH_API_KEY=your-key bash scripts/create-upstash-redis.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Upstash Redis Instance Creator${NC}"
echo "========================================"
echo ""

# Check for API key
if [ -z "$UPSTASH_API_KEY" ]; then
    echo -e "${RED}Error: UPSTASH_API_KEY not set${NC}"
    echo ""
    echo "Get your API key from: https://upstash.com/docs/management-api"
    echo "Then run:"
    echo "  export UPSTASH_API_KEY=\"your-api-key\""
    echo "  bash scripts/create-upstash-redis.sh"
    exit 1
fi

# Configuration
DB_NAME="pulse-redis"
REGION="us-east-1"
DB_TYPE="pay_as_you_go"

echo "Creating Redis database..."
echo "  Name: $DB_NAME"
echo "  Region: $REGION"
echo "  Type: $DB_TYPE"
echo ""

# Create database
RESPONSE=$(curl -s -X POST https://api.upstash.com/v1/redis/databases \
  -H "Authorization: Bearer $UPSTASH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$DB_NAME\",
    \"region\": \"$REGION\",
    \"database_type\": \"$DB_TYPE\"
  }")

# Check for errors
if echo "$RESPONSE" | grep -q "error"; then
    echo -e "${RED}Error creating database:${NC}"
    echo "$RESPONSE" | jq '.'
    exit 1
fi

# Extract credentials
DB_ID=$(echo "$RESPONSE" | jq -r '.database_id')
REST_URL=$(echo "$RESPONSE" | jq -r '.rest_url')
REST_TOKEN=$(echo "$RESPONSE" | jq -r '.rest_token')

echo -e "${GREEN}✓ Database created successfully!${NC}"
echo ""
echo "Database ID: $DB_ID"
echo ""
echo -e "${YELLOW}REST API Credentials:${NC}"
echo ""
echo "UPSTASH_REDIS_REST_URL=$REST_URL"
echo "UPSTASH_REDIS_REST_TOKEN=$REST_TOKEN"
echo ""

# Create .env.upstash file
cat > .env.upstash << EOF
# Upstash Redis Credentials
# Created at $(date)
# Database: $DB_NAME
# Region: $REGION

UPSTASH_REDIS_REST_URL=$REST_URL
UPSTASH_REDIS_REST_TOKEN=$REST_TOKEN
EOF

echo -e "${GREEN}✓ Credentials saved to: .env.upstash${NC}"
echo ""

# Test connection
echo "Testing connection..."
PING=$(curl -s -X GET "$REST_URL/ping" \
  -H "Authorization: Bearer $REST_TOKEN")

if echo "$PING" | grep -q "PONG"; then
    echo -e "${GREEN}✓ Connection verified!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Copy credentials to your .env file"
    echo "2. Add to Vercel: docs/VERCEL_UPSTASH_CONFIG.md"
    echo "3. Deploy and test"
else
    echo -e "${YELLOW}⚠ Connection test returned: $PING${NC}"
fi

echo ""
echo "All done! 🚀"
