group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx", "opencode", "pi", "hermes"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "acpx" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.acpx"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-acpx:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
