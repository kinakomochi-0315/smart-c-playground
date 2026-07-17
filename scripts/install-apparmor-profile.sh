#!/usr/bin/env bash

set -euo pipefail

profile_name="smart-c-rootless-sandbox"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile_source="${script_directory}/../infra/apparmor/${profile_name}"
profile_target="/etc/apparmor.d/${profile_name}"

if ((EUID != 0)); then
    echo "sudoで実行してください: sudo ./scripts/install-apparmor-profile.sh" >&2
    exit 1
fi

if ! command -v apparmor_parser >/dev/null 2>&1; then
    echo "apparmor_parserがありません。Ubuntuではapparmorパッケージを導入してください。" >&2
    exit 1
fi

# リポジトリのprofileをホストへ配置し、再起動を待たずenforce modeで読み込みます。
install -o root -g root -m 0644 "${profile_source}" "${profile_target}"
apparmor_parser --replace "${profile_target}"

if ! aa-status 2>/dev/null | grep -Fq "${profile_name}"; then
    echo "AppArmor profileのロードを確認できませんでした: ${profile_name}" >&2
    exit 1
fi

echo "AppArmor profileをロードしました: ${profile_name}"
