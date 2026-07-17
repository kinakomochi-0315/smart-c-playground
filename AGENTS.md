# 開発ルール

## コードスタイル

- TypeScript、JavaScript、JSON、YAMLは4スペースでインデントします。
- TypeScriptはPrettier、Rustはrustfmtの結果を正とします。
- 新しく追加する関数・クラス・公開型には、日本語のTSDocまたはRustdocを付けます。
- 実装上の判断やセキュリティ境界が読み取りにくい箇所には、適量の日本語コメントを付けます。

## プロダクト境界

- 対象言語はC17だけです。
- v1は単一ファイル `main.c` だけを扱います。
- LSP診断があっても実行を禁止しません。実コンパイラの結果を正とします。
- source、stdin、terminal outputをサーバー側へ永続化またはログ出力しません。
- sourceのブラウザ内localStorage保存は、利用者端末だけに閉じたv1の明示機能として扱います。

## セキュリティ

- Productionでdirect executor backendを使用してはいけません。
- executor-workerへDocker Socket、host filesystem、host network、host PIDを渡してはいけません。
- NsJail smoke testを通せないアーキテクチャを匿名公開してはいけません。
- resource limit、ticketの一回限り性、切断時cleanupを変更する場合は、対応するテストも更新します。
