#!/bin/bash
# Wrapper für den täglichen Engineering-Report (launchd de.whitestag.engineering-report)
cd "$(dirname "$0")" || exit 1
exec /usr/bin/python3 engineering_report.py "$@"
