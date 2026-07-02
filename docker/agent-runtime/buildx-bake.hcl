group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx", "opencode", "pi", "hermes"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "acpx" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.acpx"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-acpx:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
