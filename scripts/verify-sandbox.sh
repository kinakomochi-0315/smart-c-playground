#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(cd -- "${script_directory}/.." && pwd)"
env_file="${ENV_FILE:-.env.production}"
if [[ "${env_file}" != /* ]]; then
    env_file="${project_directory}/${env_file}"
fi
if [[ ! -f "${env_file}" ]]; then
    echo "Production環境変数ファイルがありません: ${env_file}" >&2
    echo "ENV_FILEで対象ファイルを指定してください。" >&2
    exit 1
fi

compose_arguments=(
    --project-directory
    "${project_directory}"
    -f
    "${project_directory}/compose.yaml"
    -f
    "${project_directory}/compose.prod.yaml"
)
apparmor_overlay="${APPARMOR_OVERLAY:-auto}"
if [[ "${apparmor_overlay}" == "true" ]]; then
    compose_arguments+=(-f "${project_directory}/compose.apparmor.yaml")
elif [[ "${apparmor_overlay}" == "auto" ]]; then
    if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] \
        && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]]; then
        compose_arguments+=(-f "${project_directory}/compose.apparmor.yaml")
    fi
elif [[ "${apparmor_overlay}" != "false" ]]; then
    echo "APPARMOR_OVERLAYはauto、true、falseのいずれかにしてください。" >&2
    exit 1
fi

# 本番と同じNsJail backendで、隔離の必須条件をまとめて確認します。
docker compose \
    --env-file "${env_file}" \
    "${compose_arguments[@]}" \
    run \
    --rm \
    --no-deps \
    executor-worker \
    sandbox-smoke-test
