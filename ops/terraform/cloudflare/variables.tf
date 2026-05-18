variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with Zone and Access permissions"
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for thegoodguys.la"
}

variable "paperclip_subdomain" {
  type        = string
  default     = "paperclip.thegoodguys.la"
  description = "Full subdomain for the Paperclip dashboard"
}

variable "allowed_emails" {
  type        = list(string)
  description = "Email addresses allowed through Cloudflare Access"
}
