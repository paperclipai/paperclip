#!/bin/bash
cd "$(dirname "$0")"
if command -v node &> /dev/null; then
  node serve.js
else
  echo "Error: Node.js is required to view these docs."
  echo "Install Node.js from https://nodejs.org"
  read -p "Press Enter to exit..."
fi
