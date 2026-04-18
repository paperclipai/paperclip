import core from "./core.json";
import dashboard from "./dashboard.json";
import issues from "./issues.json";
import instance from "./instance.json";
import agents from "./agents.json";
import company from "./company.json";
import details from "./details.json";
import auth from "./auth.json";
import misc from "./misc.json";
import routines from "./routines.json";
import costs from "./costs.json";
import onboarding from "./onboarding.json";

export default {
  ...core,
  ...dashboard,
  ...issues,
  ...instance,
  ...agents,
  ...company,
  ...details,
  ...auth,
  ...misc,
  ...routines,
  ...costs,
  ...onboarding,
};
