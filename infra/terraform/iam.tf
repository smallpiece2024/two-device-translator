# GCE VM にアタッチするサービスアカウント。
# 最小権限: Speech-to-Text と Translation の利用ロールのみ付与する。
# Text-to-Speech はカスタムIAMロールが存在せず、API有効化のみで呼び出し可能
# （gcp-specialist によるgcloud実機検証済み）。

resource "google_service_account" "translator_vm" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "Translator VM service account"
  description  = "GCE VM(Next.js + WSサーバー)にアタッチし、Speech-to-Text/Translation/Text-to-SpeechをADC経由で呼び出すためのサービスアカウント"
}

resource "google_project_iam_member" "speech_client" {
  project = var.project_id
  role    = "roles/speech.client"
  member  = "serviceAccount:${google_service_account.translator_vm.email}"
}

resource "google_project_iam_member" "translate_user" {
  project = var.project_id
  role    = "roles/cloudtranslate.user"
  member  = "serviceAccount:${google_service_account.translator_vm.email}"
}
