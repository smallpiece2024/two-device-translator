# Cloud DNS: 公開ドメイン(var.domain)のマネージドゾーンとAレコード。
# レジストラ（ドメイン購入元）側では、ここで作成したゾーンのネームサーバーへの
# NS委任のみを手動設定する（outputs.tf の name_servers を参照）。

resource "google_dns_managed_zone" "translator_zone" {
  project     = var.project_id
  name        = "translator-zone"
  dns_name    = "${var.domain}."
  description = "two-device-translator 公開ドメイン(${var.domain})のマネージドゾーン"

  depends_on = [
    google_project_service.required,
  ]
}

# apex ドメインのAレコード。GCE VMの静的IPをrrdatasで直接参照し、
# 手動転記によるIP不一致を防ぐ。
resource "google_dns_record_set" "translator_apex_a" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.translator_zone.name
  name         = google_dns_managed_zone.translator_zone.dns_name
  type         = "A"
  ttl          = 300

  rrdatas = [google_compute_address.vm_static_ip.address]
}
