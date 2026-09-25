# 個人写真一括リネーマー

ブラウザで動作する NOBATASU Tools 由来の独立配布版です。DB・アカウント・PHP処理は不要です。

## 利用方法

### すぐ使う

[公式サイトで写真名簿リネームを使う](https://nobatasu.com/app/tools/photo-rename-roster/)

公式サイトはブラウザだけで利用できます。通常利用ではDockerのインストールは不要です。

### 自分のPCで動かす・改良する

以下のローカル起動手順を使います。Dockerは任意で、Dockerなしでも起動できます。アプリによってはブラウザでHTMLファイルを直接開くと動作しないため、`localhost`のHTTPサーバー経由で開いてください。

## ローカルで起動する

### Dockerを使う

Docker を使う場合は `docker compose up --build` を実行し、http://127.0.0.1:8091/ を開きます。ポートが使用中ならComposeの左側のポートを変更してください。

### Dockerを使わない

DockerなしではPython 3.10以上とNode.js 22を用意して実行します。

```sh
npm ci --ignore-scripts
python3 scripts/build.py
python3 -m http.server 8091 --bind 127.0.0.1 --directory build/site
```

編集する正本は `src/` のTypeScriptです。ビルド時に `dist/` を再生成します。 必要なライブラリはローカル同梱しています。初回のDockerイメージ取得・npm依存インストールにはインターネット接続が必要ですが、通常のアプリ画面は外部CDNを取得しません。

## 開発・テスト

Python 3.10以上とNode.js 22を用意し、リポジトリのルートで依存関係をインストールして配布物をビルドしてから検査します。

```sh
npm ci --ignore-scripts
python3 scripts/build.py
npm run typecheck
python3 -m unittest scripts/test_build.py
node --experimental-strip-types --test tests/photo-rename-core.test.mjs
```

`scripts/test_build.py` は、生成ZIPと配布ファイル構成を検査します。アプリの全操作を機能検証するものではありません。

`photo-rename-core.test.mjs` は、架空ファイルを使ってリネーム処理の主要な分岐を検査します。OSのフォルダ選択や権限ダイアログを含む実操作は対象外です。

## データの扱い

入力内容を外部サーバーへ送信する処理はありません。アプリの設定・入力は、画面の保存機能やブラウザの localStorage に残る場合があります。共有端末では利用後に画面の消去機能を使い、残る情報はブラウザのサイトデータから削除してください。ダウンロードしたファイルは各自で管理してください。

フォルダ操作にはFile System Access APIに対応したChrome/Edge系ブラウザとHTTPSまたはlocalhostが必要です。選択したフォルダへの書き込み権限を要求します。元写真の複製で動作を確認してください。リネームを実行すると、新しい名前のファイルを保存・検証した後に元の名前のファイルを削除します。フォルダ内の実ファイルを変更する操作なので、事前のバックアップを保持してください。

## 動作確認の範囲

Chromeの初期表示・ソース取得と、Node.js 22で53件の架空ファイル操作テストを確認しています。OSのフォルダ選択・権限ダイアログを通した実操作は自動検証の対象外です。

## ソースとライセンス

アプリのコード・デザインは **AGPL-3.0-or-later**。第三者ライブラリ・フォントには原ライセンスが適用されます（`THIRD-PARTY-NOTICES.md`）。名称・ブランドは `TRADEMARKS.md` を参照してください。

画面の「この版のソース」は、そのビルドに対応した `source/photo-rename-roster-source.zip` を取得します。ZIPには編集用ソース、ビルド設定、ライセンス、検証コードが含まれます。改変して配信するときも `python3 scripts/build.py` で対応するZIPを生成し、`build/site/` 全体を配置してください。

この独立版は公式サイトの外枠・広告・ブランド画像を含みません。公式サイトで稼働中の版そのものの対応ソースを示すものではありません。

公開リポジトリ: https://github.com/kurumi0715555/photo-rename-roster

開発の正本で検証した変更を、このPublicリポジトリのmainへ反映します。提案はmain向けPull Requestで受け付けます。公開側CIには公式サイトへの配信権限はありません。

## 配布ファイル

- HTML/CSS/JS、必要な画像生成・Excel等のライブラリ: アプリ実行用。
- src・package設定（TS版）、scripts、テスト: 改良・再ビルド・検証用。
- DockerとCI: ローカル起動・変更検証用。
- README・LICENSE・通知: 利用方法・再配布条件。

`build/site/` はアプリ実行ファイルと対応ソースZIPだけを含みます。READMEやテストは通常のWeb画面として配置しません。
