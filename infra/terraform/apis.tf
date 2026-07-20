# 必要な GCP API を有効化する。
# disable_on_destroy = false: `terraform destroy` 時にAPI自体を無効化しない
# （他リソース・将来の再作成に影響を与えないため）。

locals {
  required_apis = [
    "compute.googleapis.com",
    "speech.googleapis.com",
    "translate.googleapis.com",
    "texttospeech.googleapis.com",
    "iap.googleapis.com",
    "dns.googleapis.com",
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
