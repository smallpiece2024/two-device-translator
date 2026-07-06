# 静的外部IPv4（DNS Aレコードの安定化のため）。
resource "google_compute_address" "vm_static_ip" {
  project      = var.project_id
  region       = var.region
  name         = "${var.instance_name}-ip"
  address_type = "EXTERNAL"

  depends_on = [
    google_project_service.required,
  ]
}

# HTTP/HTTPS はインターネット全体に開放（Caddy が終端する）。
resource "google_compute_firewall" "allow_https" {
  project = var.project_id
  name    = "allow-https"
  network = "default"

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["translator-vm"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  depends_on = [
    google_project_service.required,
  ]
}

# SSH は IAP TCP フォワーディングの送信元範囲からのみ許可する。
# OS Login（compute.tf の metadata で有効化）と組み合わせ、公開鍵の事前配布や
# 0.0.0.0/0 への22番ポート開放を避ける。
resource "google_compute_firewall" "allow_ssh_iap" {
  project = var.project_id
  name    = "allow-ssh-iap"
  network = "default"

  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["translator-vm"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  depends_on = [
    google_project_service.required,
  ]
}
