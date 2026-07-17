#!/usr/bin/env bash

set -euo pipefail

error_count=0

# 公開用NsJail Workerを起動できるLinuxホストかを検査します。
check() {
    local description="$1"
    shift

    if "$@" >/dev/null 2>&1; then
        echo "[ok] ${description}"
    else
        echo "[error] ${description}" >&2
        error_count=$((error_count + 1))
    fi
}

check_value() {
    local description="$1"
    local actual="$2"
    local expected_pattern="$3"

    if [[ "${actual}" =~ ${expected_pattern} ]]; then
        echo "[ok] ${description}: ${actual}"
    else
        echo "[error] ${description}: ${actual}" >&2
        error_count=$((error_count + 1))
    fi
}

check_value "OS" "$(uname -s)" "^Linux$"
check_value "CPU architecture" "$(uname -m)" "^(x86_64|aarch64|arm64)$"
check "Docker Engine" docker info
check "Docker Compose" docker compose version
check "cgroup v2" test -f /sys/fs/cgroup/cgroup.controllers
# ホストのPID 1ではなく、実際に利用するDockerデーモンのセキュリティ機能を検査します。
check \
    "Docker seccomp runtime" \
    sh -c 'docker info --format "{{json .SecurityOptions}}" | grep -q "\"name=seccomp"'

if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]]; then
    check_value \
        "unprivileged user namespaces" \
        "$(cat /proc/sys/kernel/unprivileged_userns_clone)" \
        "^1$"
else
    echo "[info] kernel.unprivileged_userns_clone is not exposed; the container smoke test decides support"
fi

if [[ -r /proc/sys/user/max_user_namespaces ]]; then
    max_user_namespaces="$(cat /proc/sys/user/max_user_namespaces)"
    if ((max_user_namespaces > 0)); then
        echo "[ok] user namespace capacity: ${max_user_namespaces}"
    else
        echo "[error] user namespace capacity is zero" >&2
        error_count=$((error_count + 1))
    fi
fi

if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] \
    && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]]; then
    check "AppArmor tooling" command -v aa-status
    check \
        "smart-c rootless sandbox AppArmor profile" \
        sh -c 'aa-status 2>/dev/null | grep -Fq "smart-c-rootless-sandbox"'
    echo "[info] Add compose.apparmor.yaml when starting the stack on this host"
fi

if ((error_count > 0)); then
    echo "Production preflight failed with ${error_count} error(s)." >&2
    exit 1
fi

echo "Host-level checks passed. Run the executor-worker sandbox smoke test before publication."
