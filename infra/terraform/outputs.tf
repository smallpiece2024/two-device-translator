output "vm_static_ip" {
  description = "GCE VMの静的外部IPアドレス（DNS Aレコードをこの値に向ける）"
  value       = google_compute_address.vm_static_ip.address
}

output "instance_name" {
  description = "GCE VMのインスタンス名"
  value       = google_compute_instance.translator_vm.name
}

output "service_account_email" {
  description = "GCE VMにアタッチしたサービスアカウントのメールアドレス"
  value       = google_service_account.translator_vm.email
}

output "dns_name_servers" {
  description = "Cloud DNS マネージドゾーンのネームサーバー一覧（レジストラでのNS委任設定に使用）"
  value       = google_dns_managed_zone.translator_zone.name_servers
}
