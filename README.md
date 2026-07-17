# ✨かしこい✨C言語実行環境

ブラウザ上で単一の `main.c` を編集し、clangdによる補完・実行前診断と、標準入出力を使った対話実行を行えるC17専用のWebアプリケーションです。

## 主な機能

- CodeMirror 6によるC言語編集
- clangdによる補完、ホバー、診断
- xterm.jsとPTYによる `scanf`、`fgets`、`getchar` などの対話入出力
- Clang C17によるコンパイル
- 短命・一回限りのHttpOnly WebSocket ticket
- visitor/IP単位のレート制限と同時実行制限
- Docker Composeによる一体型デプロイ
- ProductionでのNsJail、seccomp、rlimit、Docker resource limit

C言語以外、複数ファイル、シェル、raw mode、ncursesは対象外です。

## 構成

```text
apps/
    web/                 Next.js UI / BFF
    lsp/                 Hono / clangd WebSocket bridge
crates/
    executor-api/        REST / WebSocket / queue / gRPC control plane
    executor-protocol/   APIとWorker間のProtocol Buffers
    executor-worker/     Clang / PTY / NsJail execution worker
packages/
    contracts/           TypeScript共有契約
infra/
    nsjail/              compile/runtime jail設定とseccomp policy
```

通信経路と責務の詳細は [docs/architecture.md](docs/architecture.md)、公開前の安全条件は [docs/security.md](docs/security.md) を参照してください。

## ローカル起動

必要なもの:

- Docker EngineまたはDocker Desktop
- Docker Compose
- Node.js 22以上、pnpm 10.20.0（検証コマンドをローカル実行する場合）
- Rust 1.85以上（Rust検証をローカル実行する場合）

アプリケーション全体を起動します。

```bash
pnpm install
pnpm dev
```

ブラウザで `http://localhost:8080` を開きます。終了時は次を実行します。

```bash
pnpm dev:down
```

ローカルComposeは移植性を優先し、executorに `direct` backendを使用します。信頼できない利用者へ公開してはいけません。

## 検証

```bash
pnpm verify
pnpm compose:config
PUBLIC_HOST=localhost \
WEB_VISITOR_SECRET=ci-web-visitor-secret-with-sufficient-length \
LSP_INTERNAL_TOKEN=ci-lsp-internal-token-with-sufficient-length \
LSP_TICKET_SECRET=ci-lsp-ticket-secret-with-sufficient-length \
EXECUTOR_INTERNAL_TOKEN=ci-executor-internal-token-with-sufficient-length \
EXECUTOR_TICKET_SECRET=ci-executor-ticket-secret-with-sufficient-length \
WORKER_SERVICE_TOKEN=ci-worker-service-token-with-sufficient-length \
pnpm compose:config:prod
```

`pnpm verify` はPrettier、ESLint、TypeScript、JavaScriptテスト、rustfmt、Clippy、Rustテスト、全ビルドを実行します。

Ubuntu 24.04など、AppArmorがunprivileged user namespaceを制限するホストでは、専用profileを一度ロードしてからAppArmor overlayを追加します。ホスト全体のuser namespace制限は解除しません。

```bash
sudo ./scripts/install-apparmor-profile.sh
docker compose \
    -f compose.yaml \
    -f compose.apparmor.yaml \
    up --build
```

## Production

Productionはnative Linuxの `amd64` と `arm64` を対象とします。Docker Desktop上でイメージをビルドできても、Linuxホスト上のNsJail動作を証明したことにはなりません。

1. `.env.production.example` を `.env.production` へコピーし、各サービス境界に異なる十分に長い秘密値と公開ホスト名を設定します。
2. 対象ホストで事前条件を確認します。
3. 本番構成を起動します。
4. NsJail smoke testと攻撃ケースを実行します。

```bash
cp .env.production.example .env.production
./scripts/preflight-host.sh
docker compose \
    --env-file .env.production \
    -f compose.yaml \
    -f compose.prod.yaml \
    up --build -d
./scripts/verify-sandbox.sh
```

AppArmorのuser namespace制限が有効なホストでは、profileをロードしたうえで本番起動にも `-f compose.apparmor.yaml` を追加してください。`scripts/preflight-host.sh` は必要なprofileが未ロードなら失敗します。
`scripts/verify-sandbox.sh` はホストの制限を検出して同overlayを自動適用します。自動検出できないAppArmor環境では `APPARMOR_OVERLAY=true ./scripts/verify-sandbox.sh` と明示できます。

切断・停止・Worker crash後のcleanupとreadiness回復は、公開ポート `127.0.0.1:18081` だけを使う独立した本番相当stackで検証します。

```bash
pnpm verify:runtime-cleanup
```

次の条件を満たせないホストまたはCPUアーキテクチャは匿名公開しないでください。

- `privileged: false` のままNsJailを起動できる
- 外向きnetwork、fork、ptrace、mount、host filesystem参照を拒否できる
- CPU、wall time、memory、PID、出力量の各上限を強制できる
- WebSocket切断、停止、Worker異常終了後にプロセスとworkspaceが残らない

Docker Desktop上のarm64/Linux VMでは上記smokeを確認済みですが、native Linuxの `amd64` / `arm64` はそれぞれ実機で同じ検証を通すまで匿名公開対象に含めません。

## 既定の制限

| 対象              |                                 上限 |
| ----------------- | -----------------------------------: |
| ソース            |                                64KiB |
| コンパイル        |             wall 5秒 / memory 512MiB |
| 実行              | CPU 3秒 / wall 120秒 / memory 128MiB |
| 端末出力          |                                 1MiB |
| LSP同時セッション |                                    2 |
| 全体同時実行      |                                    4 |
| 待機キュー        |                                   16 |
| visitor同時実行   |                                    1 |
| IP同時実行        |                                    2 |

## ライセンス

プロジェクト独自のコードと文書は [WTFPL Version 2](LICENSE) で提供します。
第三者由来のファイルと依存コンポーネントには、それぞれのライセンスが引き続き適用されます。
詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
