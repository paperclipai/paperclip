// Compatibility boundary: both provisioning paths converge on the same Slack runtime.
export { slackChatRegistrationService } from "./connectors/slack/setup/service.js";
export { slackRegistrationProjection, type SlackSetupActor } from "./connectors/slack/setup/registration.js";
