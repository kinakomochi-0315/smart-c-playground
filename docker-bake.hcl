group "ci" {
    targets = ["web", "lsp", "executor-api", "executor-worker"]
}

variable "PLATFORMS" {
    default = ["linux/amd64", "linux/arm64"]
}

target "_common" {
    context   = "."
    platforms = PLATFORMS
}

target "web" {
    inherits   = ["_common"]
    dockerfile = "apps/web/Dockerfile"
    target     = "production"
}

target "lsp" {
    inherits   = ["_common"]
    dockerfile = "apps/lsp/Dockerfile"
    target     = "production"
}

target "executor-api" {
    inherits   = ["_common"]
    dockerfile = "crates/executor-api/Dockerfile"
    target     = "production"
}

target "executor-worker" {
    inherits   = ["_common"]
    dockerfile = "crates/executor-worker/Dockerfile"
    target     = "production"
}
