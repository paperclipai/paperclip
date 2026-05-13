group "default" {
  targets = ["base", "claude"]
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
