#!/usr/bin/env bash
# Provision JDK 8 + Maven for Maven-based execution workspaces (e.g. RIMS Backend).
set -euo pipefail

if command -v mvn >/dev/null 2>&1; then
  mvn -version
  exit 0
fi

if command -v sdk >/dev/null 2>&1; then
  sdk install java 8.0.392-zulu 2>/dev/null || true
  sdk install maven 3.9.6 2>/dev/null || true
  sdk default java 8.0.392-zulu 2>/dev/null || true
  sdk default maven 3.9.6 2>/dev/null || true
elif command -v apt-get >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq openjdk-8-jdk-headless maven
  else
    apt-get update -qq
    apt-get install -y -qq openjdk-8-jdk-headless maven
  fi
else
  echo "No supported package manager found to install JDK8 + Maven" >&2
  exit 1
fi

mvn -version
