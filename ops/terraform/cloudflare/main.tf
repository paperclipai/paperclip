terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_zone_setting" "bot_fight_mode" {
  zone_id = var.cloudflare_zone_id
  setting_id = "browser_check"
  value = "off"
}

resource "cloudflare_zone_setting" "security_level" {
  zone_id = var.cloudflare_zone_id
  setting_id = "security_level"
  value = "medium"
}

resource "cloudflare_access_application" "paperclip" {
  zone_id = var.cloudflare_zone_id
  name    = "Paperclip Dashboard"
  domain  = var.paperclip_subdomain
  session_duration = "24h"
}

resource "cloudflare_access_policy" "paperclip_allow" {
  application_id = cloudflare_access_application.paperclip.id
  zone_id        = var.cloudflare_zone_id
  name           = "Allow team"
  precedence     = "1"
  decision       = "allow"

  include {
    email = var.allowed_emails
  }
}
