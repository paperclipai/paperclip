#!/bin/bash

# Don't exit immediately so we can debug issues
# set -e

# Function to replace localhost in a string with the Docker host
replace_localhost() {
    local input_str="$1"
    local docker_host=""

    # Try to determine Docker host address
    if ping -c 1 -w 1 host.docker.internal >/dev/null 2>&1; then
        docker_host="host.docker.internal"
        echo "Docker Desktop detected: Using host.docker.internal for localhost" >&2
    elif ping -c 1 -w 1 172.17.0.1 >/dev/null 2>&1; then
        docker_host="172.17.0.1"
        echo "Docker on Linux detected: Using 172.17.0.1 for localhost" >&2
    else
        echo "WARNING: Cannot determine Docker host IP. Using original address." >&2
        return 1
    fi

    # Replace localhost with Docker host
    if [[ -n "$docker_host" ]]; then
        local new_str="${input_str/localhost/$docker_host}"
        echo "  Remapping: $input_str --> $new_str" >&2
        echo "$new_str"
        return 0
    fi

    # No replacement made
    echo "$input_str"
    return 1
}

# Create a new array for the processed arguments
processed_args=()
processed_args+=("$1")
shift 1

# Process remaining command-line arguments for postgres:// or postgresql:// URLs that contain localhost
for arg in "$@"; do
    if [[ "$arg" == *"postgres"*"://"*"localhost"* ]]; then
        echo "Found localhost in database connection: $arg" >&2
        new_arg=$(replace_localhost "$arg")
        if [[ $? -eq 0 ]]; then
            processed_args+=("$new_arg")
        else
            processed_args+=("$arg")
        fi
    else
        processed_args+=("$arg")
    fi
done

# Check and replace localhost in DATABASE_URI if it exists
if [[ -n "$DATABASE_URI" && "$DATABASE_URI" == *"postgres"*"://"*"localhost"* ]]; then
    echo "Found localhost in DATABASE_URI: $DATABASE_URI" >&2
    new_uri=$(replace_localhost "$DATABASE_URI")
    if [[ $? -eq 0 ]]; then
        export DATABASE_URI="$new_uri"
    fi
fi

# Check if SSE transport is specified and --sse-host is not already set
has_sse=false
has_sse_host=false

for arg in "${processed_args[@]}"; do
    if [[ "$arg" == "--transport" ]]; then
        # Check next argument for "sse"
        for next_arg in "${processed_args[@]}"; do
            if [[ "$next_arg" == "sse" ]]; then
                has_sse=true
                break
            fi
        done
    elif [[ "$arg" == "--transport=sse" ]]; then
        has_sse=true
    elif [[ "$arg" == "--sse-host"* ]]; then
        has_sse_host=true
    fi
done

# Add --sse-host if needed
if [[ "$has_sse" == true ]] && [[ "$has_sse_host" == false ]]; then
    echo "SSE transport detected, adding --sse-host=0.0.0.0" >&2
    processed_args+=("--sse-host=0.0.0.0")
fi

echo "----------------" >&2
echo "Executing command:" >&2
echo "${processed_args[@]}" >&2
echo "----------------" >&2

# Execute the command with the processed arguments
# Use exec to replace the shell with the Python process, making it PID 1
# This ensures signals (SIGTERM, SIGINT) are properly received
exec "${processed_args[@]}"
