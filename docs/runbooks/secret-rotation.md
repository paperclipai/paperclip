# Secret rotation runbook

1. Rotate platform secrets:
`BETTER_AUTH_SECRET`
`PAPERCLIP_SAAS_CONTROL_TOKEN`
2. Rotate tenant provider secrets through UI:
`/<companyPrefix>/onboarding/connect-providers`
3. Rotate OpenClaw gateway token using internal runner provisioning endpoint.
4. Validate post-rotation:
provider status endpoint
new heartbeat run
invite acceptance flow
5. Record rotation event in ops changelog.

