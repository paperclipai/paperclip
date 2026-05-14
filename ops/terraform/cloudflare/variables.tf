variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone settings + Access app/policy permissions."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for Zero Trust Access resources."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for thegoodguys.la."
  type        = string
}

variable "paperclip_subdomain" {
  description = "Subdomain for Paperclip dashboard host."
  type        = string
  default     = "paperclip"
}

variable "allowed_emails" {
  description = "Allowed emails for Cloudflare Access policy."
  type        = list(string)
  default     = []
}

