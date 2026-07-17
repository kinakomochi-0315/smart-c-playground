# 第三者ライセンス通知

ルートのWTFPLは、プロジェクト独自のコードと文書に適用されます。
次の第三者由来コンポーネントには、それぞれのライセンスが引き続き適用されます。

## Moby default seccomp profile

`infra/nsjail/worker-outer.seccomp.json` は、
[Mobyのdefault seccomp profile](https://github.com/moby/profiles/blob/main/seccomp/default.json)
を基準にしています。対象アーキテクチャを限定し、NsJailとbubblewrapに必要なnamespace操作を
許可する変更を加えています。このファイル全体は Apache License 2.0 で提供します。
変更内容の通知は
[`infra/nsjail/worker-outer.seccomp.json.NOTICE`](infra/nsjail/worker-outer.seccomp.json.NOTICE)
にも記載しています。

## NsJail

`crates/executor-worker/Dockerfile` は
[NsJail 3.6](https://github.com/google/nsjail/tree/3.6) をビルドし、production imageへ収録します。
NsJailには Apache License 2.0 が適用されます。

Apache License 2.0の全文は [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) にあります。
package managerを通じて取得するその他の依存コンポーネントには、各配布元のライセンスが適用されます。
