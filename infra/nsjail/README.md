# NsJail実行前提

Workerイメージは次を満たす必要があります。

- `/usr/bin/clang` と `/usr/bin/musl-gcc` を含む。
- `/usr/local/bin/nsjail` を含む。
- 空のchroot `/jail/workspace` と `/jail/tmp` を作成する。
- このディレクトリを `/etc/smart-c/nsjail` へread-onlyで配置する。
- `/work` は `exec,nosuid,nodev` を付けた `tmpfs` とし、Workerごとに共有しない。
- Docker Socket、host network、host PID/IPC、ホストディレクトリを渡さない。
- root filesystemをread-onlyにし、`/tmp` と `/work` だけをtmpfsにする。
- WorkerコンテナへCPU、メモリ、PIDのcgroup上限を設定する。

本番では `SMART_C_ENV=production` と `EXECUTOR_BACKEND=nsjail` を指定します。
Workerは設定・バイナリ・ポリシーのどれかが欠けると起動を拒否します。

NsJailはuser/mount/PID/network等のnamespace、seccomp、RLIMITを担当します。
非root Workerからホストのcgroup親階層は操作せず、外側のDocker cgroupと二層で制限します。
Dockerの標準seccompはNsJailが必要とするnamespace作成を拒否するため、WorkerにはNsJail起動用の
専用outer seccomp profile `worker-outer.seccomp.json` を設定します。このprofileはMobyの
default allowlistを基準に、NsJailがnamespaceとjail rootを作るための操作だけを追加しています。
このprofileはWTFPLの対象外で、Apache License 2.0のままです。由来と変更内容は
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) を参照してください。
本番で `seccomp=unconfined` へフォールバックしてはいけません。

Ubuntu 24.04等でAppArmorがuser namespaceを制限する場合は、Worker専用AppArmor profileで
`userns` を明示的に許可します。ホストpreflightと各Workerの起動時smoke testのどちらかが
失敗した場合、そのホストを公開経路へ接続してはいけません。production Workerはsmoke testが
成功するまでAPIへ登録せず、APIも設定された必要Worker数が揃うまでreadinessを返しません。
`privileged: true` やホスト全体のuser namespace制限解除は使用しません。
