resource "google_compute_instance" "translator_vm" {
  project      = var.project_id
  name         = var.instance_name
  zone         = var.zone
  machine_type = var.machine_type

  tags = ["translator-vm"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.boot_disk_size_gb
      type  = var.boot_disk_type
    }
  }

  network_interface {
    network = "default"

    access_config {
      nat_ip = google_compute_address.vm_static_ip.address
    }
  }

  service_account {
    email = google_service_account.translator_vm.email
    # 実際の権限制御は IAM ロール（iam.tf）で行う。
    scopes = ["cloud-platform"]
  }

  # SSH は IAP + OS Login のみで行う（公開鍵の個別配布は行わない）。
  metadata = {
    enable-oslogin = "TRUE"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  depends_on = [
    google_project_service.required,
  ]
}
