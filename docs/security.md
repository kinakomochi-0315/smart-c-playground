# セキュリティ方針

## 脅威モデル

匿名利用者が任意のCソースと標準入力を送信し、CPU、メモリ、PID、ディスク、出力量、外向き通信、ホストkernelの脆弱性を悪用しようとする前提です。

守る対象は次のとおりです。

- ホストと他セッションのファイル、プロセス、ネットワーク
- サービスの可用性
- 内部APIトークンとticket署名鍵
- 利用者が入力したソース、標準入力、端末出力

## 防御層

1. Caddy以外のポートを公開しません。
2. 公開RESTはOrigin、Content-Type、body size、visitor/IPレートを検証します。
3. WebSocketはセッション、visitor、パスへ紐付く30秒・一回限りのHttpOnly ticketを要求します。
4. executor-apiは全体4件、visitor 1件、IP 2件、待機16件へ制限します。
5. Workerコンテナ外側でCPU、メモリ、PID、read-only filesystem、tmpfsを制限します。
6. NsJail内側でnamespace、rlimit、seccomp、network無効化を適用します。
7. compile jailとruntime jailを分け、runtimeへcompilerやshellを渡しません。
8. source、stdin、terminal output、Cookie、ticketをログへ記録しません。
9. AppArmorがuser namespaceを制限するホストでは、専用profileをLSPとWorkerコンテナだけへ適用します。

## 公開条件

Productionはnative Linux `amd64` / `arm64` のみを保証対象とします。各アーキテクチャで次を実機検証できない限り、その環境を匿名公開しません。

- `privileged: false`
- Docker Socketとホストbind mountを使わない
- host PID、network、IPCを共有しない
- 外向きsocket、fork、ptrace、mount、host filesystem参照を拒否する
- 無限ループ、メモリ枯渇、PID枯渇、巨大出力を上限内で終了できる
- 停止、WebSocket切断、Worker crash後に実行プロセスとworkspaceが残らない

`scripts/preflight-host.sh` はホスト機能を検査しますが、それだけでは公開可否を証明しません。必ず `scripts/verify-sandbox.sh` と攻撃ケースの統合テストも実行します。

## 残存リスク

NsJailとDockerは同じLinux kernelを共有するため、microVMと同等の境界ではありません。また、レート制限だけでは分散IPからの大量実行を完全には防げません。

異常な負荷や攻撃が確認された場合は、次の順に対応します。

1. 該当環境の匿名公開を停止する。
2. Turnstileまたは認証を追加する。
3. Workerを別ホスト、gVisor、microVMのいずれかへ移行する。
