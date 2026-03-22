#!/bin/bash

# Paperclip Health Check Script
# Monitors the health of all services

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
CHECK_INTERVAL=${CHECK_INTERVAL:-30}
ALERT_EMAIL=${ALERT_EMAIL:-}
SLACK_WEBHOOK=${SLACK_WEBHOOK:-}

# Status tracking
declare -A SERVICE_STATUS
declare -A PREVIOUS_STATUS

check_service_running() {
    local service=$1
    docker-compose -f "$COMPOSE_FILE" ps | grep -q "paperclip-$service.*Up" 2>/dev/null
    return $?
}

check_service_healthy() {
    local service=$1
    local health_status=$(docker inspect "paperclip-$service" --format='{{.State.Health.Status}}' 2>/dev/null)

    if [ "$health_status" = "healthy" ] || [ -z "$health_status" ]; then
        return 0
    else
        return 1
    fi
}

check_api_health() {
    local response=$(curl -s -w "\n%{http_code}" http://localhost:3100/health 2>/dev/null)
    local http_code=$(echo "$response" | tail -n1)

    if [ "$http_code" = "200" ]; then
        return 0
    else
        return 1
    fi
}

check_nginx_health() {
    curl -s -f http://localhost/health > /dev/null 2>&1
    return $?
}

check_database_health() {
    docker-compose -f "$COMPOSE_FILE" exec -T db \
        pg_isready -U paperclip_prod -d paperclip_prod > /dev/null 2>&1
    return $?
}

check_disk_space() {
    local usage=$(docker exec paperclip-server df -h / | awk 'NR==2 {print $5}' | sed 's/%//')

    if [ "$usage" -lt 80 ]; then
        return 0
    else
        return 1
    fi
}

check_memory_usage() {
    local server=$(docker inspect --format='{{.State.Pid}}' paperclip-server)
    local db=$(docker inspect --format='{{.State.Pid}}' paperclip-db)
    local nginx=$(docker inspect --format='{{.State.Pid}}' paperclip-nginx)

    # Simple check - just verify they're running
    if [ ! -z "$server" ] && [ ! -z "$db" ] && [ ! -z "$nginx" ]; then
        return 0
    else
        return 1
    fi
}

send_alert() {
    local service=$1
    local status=$2
    local message="Paperclip $service: $status"

    if [ ! -z "$ALERT_EMAIL" ]; then
        echo "Subject: $message" | sendmail "$ALERT_EMAIL"
    fi

    if [ ! -z "$SLACK_WEBHOOK" ]; then
        local color="danger"
        [ "$status" = "recovered" ] && color="good"

        curl -X POST "$SLACK_WEBHOOK" \
            -H 'Content-Type: application/json' \
            -d "{\"attachments\":[{\"color\":\"$color\",\"title\":\"$message\",\"text\":\"Service: $service\"}]}" \
            2>/dev/null
    fi
}

print_status() {
    local service=$1
    local status=$2
    local details=$3

    case $status in
        "healthy")
            echo -e "${GREEN}✓${NC} $service: $status $details"
            ;;
        "unhealthy")
            echo -e "${RED}✗${NC} $service: $status $details"
            ;;
        "warning")
            echo -e "${YELLOW}⚠${NC} $service: $status $details"
            ;;
        *)
            echo -e "${BLUE}→${NC} $service: $status $details"
            ;;
    esac
}

run_checks() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    clear
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Paperclip Health Check - $timestamp${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # Check Container Status
    echo -e "${BLUE}Container Status:${NC}"

    if check_service_running "server"; then
        if check_service_healthy "server"; then
            print_status "API Server" "healthy"
            SERVICE_STATUS["server"]="healthy"
        else
            print_status "API Server" "unhealthy"
            SERVICE_STATUS["server"]="unhealthy"
        fi
    else
        print_status "API Server" "not running"
        SERVICE_STATUS["server"]="down"
    fi

    if check_service_running "db"; then
        if check_service_healthy "db"; then
            print_status "Database" "healthy"
            SERVICE_STATUS["db"]="healthy"
        else
            print_status "Database" "unhealthy"
            SERVICE_STATUS["db"]="unhealthy"
        fi
    else
        print_status "Database" "not running"
        SERVICE_STATUS["db"]="down"
    fi

    if check_service_running "nginx"; then
        if check_service_healthy "nginx"; then
            print_status "Nginx" "healthy"
            SERVICE_STATUS["nginx"]="healthy"
        else
            print_status "Nginx" "unhealthy"
            SERVICE_STATUS["nginx"]="unhealthy"
        fi
    else
        print_status "Nginx" "not running"
        SERVICE_STATUS["nginx"]="down"
    fi

    echo ""
    echo -e "${BLUE}Connectivity Tests:${NC}"

    if check_api_health; then
        print_status "API Health Endpoint" "responding"
        SERVICE_STATUS["api"]="healthy"
    else
        print_status "API Health Endpoint" "not responding"
        SERVICE_STATUS["api"]="unhealthy"
    fi

    if check_nginx_health; then
        print_status "Nginx Health Endpoint" "responding"
        SERVICE_STATUS["nginx_health"]="healthy"
    else
        print_status "Nginx Health Endpoint" "not responding"
        SERVICE_STATUS["nginx_health"]="unhealthy"
    fi

    if check_database_health; then
        print_status "Database Connection" "working"
        SERVICE_STATUS["db_conn"]="healthy"
    else
        print_status "Database Connection" "failed"
        SERVICE_STATUS["db_conn"]="unhealthy"
    fi

    echo ""
    echo -e "${BLUE}Resource Usage:${NC}"

    if check_disk_space; then
        local disk=$(docker exec paperclip-server df -h / | awk 'NR==2 {print $5}')
        print_status "Disk Space" "ok" "($disk used)"
    else
        local disk=$(docker exec paperclip-server df -h / | awk 'NR==2 {print $5}')
        print_status "Disk Space" "warning" "($disk used)"
    fi

    echo ""
    echo -e "${BLUE}Docker Status:${NC}"
    docker-compose -f "$COMPOSE_FILE" ps

    echo ""
    echo -e "${BLUE}Recent Logs (last 5 lines per service):${NC}"

    for service in server db nginx; do
        echo ""
        echo -e "${YELLOW}$service:${NC}"
        docker-compose -f "$COMPOSE_FILE" logs --tail=3 $service 2>/dev/null | tail -3
    done

    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Next check in: ${CHECK_INTERVAL}s${NC} (Ctrl+C to exit)"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

continuous_monitor() {
    while true; do
        run_checks
        sleep "$CHECK_INTERVAL"
    done
}

usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
    -c, --continuous    Run continuously (default: single check)
    -i, --interval N    Check interval in seconds (default: 30)
    -e, --email EMAIL   Email address for alerts
    -s, --slack URL     Slack webhook URL for alerts
    -h, --help          Show this help message

Examples:
    $0                           # Single health check
    $0 -c                        # Continuous monitoring
    $0 -c -i 60                  # Check every 60 seconds
    $0 -c -e admin@example.com   # With email alerts

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -c|--continuous)
            CONTINUOUS=true
            shift
            ;;
        -i|--interval)
            CHECK_INTERVAL="$2"
            shift 2
            ;;
        -e|--email)
            ALERT_EMAIL="$2"
            shift 2
            ;;
        -s|--slack)
            SLACK_WEBHOOK="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Main
if [ "$CONTINUOUS" = true ]; then
    continuous_monitor
else
    run_checks
fi
