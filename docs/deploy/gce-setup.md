# GCE デプロイ手順（bd-bg3）

Terraform でプロビジョニングした GCE VM に、Node.js / pm2 / Caddy をセットアップし、
Next.js（web）と WSサーバー（ws）を起動するまでの手順。**各コマンドは1行ずつ実行**すること。

関連: [docs/design/infra-design.md](../design/infra-design.md) / `infra/terraform/` / `infra/caddy/Caddyfile` / `ecosystem.config.js`

前提: `gcloud` CLI がローカルにインストール済み、GCPプロジェクト `two-device-translator` に対する権限を持つこと。

---

## 1. gcloud 認証

```
gcloud auth login
```

```
gcloud config set project two-device-translator
```

Application Default Credentials（Terraform 実行に使用）:

```
gcloud auth application-default login
```

```
gcloud auth application-default set-quota-project two-device-translator
```

---

## 2. Terraform でリソース作成

作業ディレクトリへ移動:

```
cd infra/terraform
```

初期化（プロバイダのダウンロード、state はローカル）:

```
terraform init
```

作成内容の確認:

```
terraform plan
```

適用（**実行前に plan の内容を必ず確認すること**。GCE VM・静的IP・Cloud DNS ゾーン等の課金対象リソースが作成される）:

```
terraform apply
```

適用後、出力を確認する:

```
terraform output
```

- `vm_static_ip`: GCE VM の静的外部IP（後述の動作確認・SSH に使用）
- `dns_name_servers`: Cloud DNS マネージドゾーンのネームサーバー一覧（次項でレジストラに登録する）

---

## 3. ドメインの DNS 委任（レジストラ側、手動・一度きり）

DNS レコード自体（Aレコード）は Terraform（`infra/terraform/dns.tf`）が Cloud DNS 上に自動作成する。
レジストラ（`sallytalk.jp` の購入元）側では、**Cloud DNS ゾーンへの NS 委任のみ**を手動設定する。

1. `terraform output dns_name_servers` で出力された4つのネームサーバーをコピーする。
2. レジストラの管理画面で `sallytalk.jp` のネームサーバー設定を、コピーした4つに変更する。
3. 反映確認（DNS伝播には数分〜数時間かかる場合がある）:

```
nslookup sallytalk.jp
```

```
nslookup -type=NS sallytalk.jp
```

`nslookup sallytalk.jp` の応答が `terraform output vm_static_ip` の値と一致すれば伝播完了。

---

## 4. IAP 経由 SSH

OS Login が有効化済み（Terraform の VM metadata `enable-oslogin=TRUE`）のため、
事前の公開鍵配布は不要。IAP TCP フォワーディング経由で接続する。

> 操作者アカウントには `roles/iap.tunnelResourceAccessor` と `roles/compute.osLogin` の付与が必要（プロジェクト Owner ロールを持つ場合は包含済みのため追加設定不要）。

```
gcloud compute ssh translator-vm --zone=asia-northeast1-b --tunnel-through-iap
```

初回接続時、IAP トンネル用の一時的な SSH 鍵が自動生成される（プロンプトに従う）。

---

## 5. VM 内セットアップ

以降は SSH 接続した VM 内で実行する。

### 5.1 スワップ設定（`next build` をVM上で行う場合のみ）

e2-small（2GB）で `next build` を実行するとメモリ不足になりうるため、
CI/ローカルでビルドした成果物を転送する方式を優先する（推奨）。
やむを得ず VM 上でビルドする場合はスワップを設定する:

```
sudo fallocate -l 2G /swapfile
```

```
sudo chmod 600 /swapfile
```

```
sudo mkswap /swapfile
```

```
sudo swapon /swapfile
```

```
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 5.2 Node.js 24（NodeSource）のインストール

```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```

```
sudo apt-get install -y nodejs
```

```
node --version
```

### 5.3 pm2 のインストール

```
sudo npm install -g pm2
```

### 5.4 Caddy のインストール

```
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```
sudo apt-get update
```

```
sudo apt-get install -y caddy
```

### 5.5 リポジトリの配置

```
sudo mkdir -p /opt/two-device-translator
```

```
sudo chown $USER:$USER /opt/two-device-translator
```

```
git clone https://github.com/smallpiece2024/two-device-translator.git /opt/two-device-translator
```

```
cd /opt/two-device-translator
```

### 5.6 `.env` の配置

`.env.example` を参考に、VM 上に `.env` を作成する（**コミットしない**）。
`GOOGLE_CLOUD_PROJECT` を除き、[infra-design.md の環境変数一覧](../design/infra-design.md#環境変数一覧) を参照。
GCP 認証は VM にアタッチしたサービスアカウント（ADC）を使うため、GCP の鍵ファイルは不要。

```
nano .env
```

`APP_DOMAIN=sallytalk.jp` を含めること（Caddy が参照する）。

### 5.7 依存関係インストールとビルド

CI/ローカルでビルド済みの `.next/standalone` と `dist-server/` を転送する場合は本項をスキップし、
`scp` / `rsync` 等で成果物を配置してから 5.8 に進む。VM 上でビルドする場合:

```
npm ci
```

```
npm run build
```

```
npm run build:server
```

standalone 出力には静的アセットが含まれないため、追加でコピーする:

```
cp -r public .next/standalone/
```

```
cp -r .next/static .next/standalone/.next/
```

### 5.8 pm2 起動と自動起動設定

```
pm2 start ecosystem.config.js
```

```
pm2 save
```

```
pm2 startup
```

`pm2 startup` の出力に表示されるコマンド（`sudo env PATH=... pm2 startup ...`）をコピーして実行する。

### 5.9 Caddyfile の配置

```
sudo cp infra/caddy/Caddyfile /etc/caddy/Caddyfile
```

Caddy が `APP_DOMAIN` を参照できるよう、systemd の環境変数として設定する:

```
sudo systemctl edit caddy
```

エディタが開くので以下を追記して保存する:

```
[Service]
Environment="APP_DOMAIN=sallytalk.jp"
```

Caddy を再起動する:

```
sudo systemctl restart caddy
```

```
sudo systemctl enable caddy
```

---

## 6. 動作確認

```
curl -I https://sallytalk.jp
```

- HTTPS で 200 系のレスポンスが返ること（Let's Encrypt 証明書が自動取得されていること）。
- ブラウザで `https://sallytalk.jp` にアクセスし、マイク許可（HTTPSのセキュアコンテキスト）を含めて動作確認する。
- `pm2 logs` で web / ws 双方のプロセスにエラーが出ていないことを確認する。

```
pm2 logs
```

---

## 今後のデプロイ（更新時）

初回セットアップ後の更新は [infra-design.md「CD（対象外）」](../design/infra-design.md#cd対象外) の手動デプロイ手順（`git pull` → `npm ci` → `build` → `build:server` → `pm2 reload ecosystem.config.js`）に従う。
