provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  paperclip_hostname = "${var.paperclip_subdomain}.thegoodguys.la"
}

# PR6 requirement: disable Bot Fight Mode for the zone to avoid false positives.
resource "cloudflare_zone_setting" "bot_fight_mode" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "bot_fight_mode"
  value      = "off"
}

# PR6 requirement: security level medium.
resource "cloudflare_zone_setting" "security_level" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "security_level"
  value      = "medium"
}

# Cloudflare Access application for paperclip.thegoodguys.la
resource "cloudflare_access_application" "paperclip_dashboard" {
  zone_id          = var.cloudflare_zone_id
  name             = "paperclip-dashboard"
  domain           = local.paperclip_hostname
  session_duration = "24h"
  type             = "self_hosted"
}

# Reusable allow policy for named emails.
resource "cloudflare_access_policy" "paperclip_allow_emails" {
  application_id = cloudflare_access_application.paperclip_dashboard.id
  zone_id        = var.cloudflare_zone_id
  name           = "paperclip-allow-emails"
  precedence     = 1
  decision       = "allow"

  include {
    email = var.allowed_emails
  }
}

