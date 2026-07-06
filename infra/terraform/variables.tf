variable "project_id" {
  description = "GCPプロジェクトID"
  type        = string
  default     = "two-device-translator"
}

variable "region" {
  description = "リソースを配置するリージョン（東京）"
  type        = string
  default     = "asia-northeast1"
}

variable "zone" {
  description = "GCE VMを配置するゾーン"
  type        = string
  default     = "asia-northeast1-b"
}

variable "domain" {
  description = "公開ドメイン（Caddy が Let's Encrypt 証明書を取得する対象）"
  type        = string
  default     = "sallytalk.jp"
}

variable "machine_type" {
  description = "GCE VMのマシンタイプ"
  type        = string
  default     = "e2-small"
}

variable "boot_disk_size_gb" {
  description = "ブートディスクのサイズ（GB）"
  type        = number
  default     = 20
}

variable "boot_disk_type" {
  description = "ブートディスクの種別"
  type        = string
  default     = "pd-balanced"
}

variable "instance_name" {
  description = "GCE VMのインスタンス名"
  type        = string
  default     = "translator-vm"
}

variable "service_account_id" {
  description = "VMにアタッチするサービスアカウントのID（プロジェクト内で一意）"
  type        = string
  default     = "translator-vm"
}
