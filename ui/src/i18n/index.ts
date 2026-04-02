import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Korean translations
import koCommon from "./ko/common.json";
import koAuth from "./ko/auth.json";
import koNav from "./ko/nav.json";
import koDashboard from "./ko/dashboard.json";
import koAgents from "./ko/agents.json";
import koIssues from "./ko/issues.json";
import koProjects from "./ko/projects.json";
import koGoals from "./ko/goals.json";
import koRoutines from "./ko/routines.json";
import koSettings from "./ko/settings.json";
import koApprovals from "./ko/approvals.json";
import koCosts from "./ko/costs.json";
import koPlugins from "./ko/plugins.json";
import koOnboarding from "./ko/onboarding.json";
import koInbox from "./ko/inbox.json";
import koOrg from "./ko/org.json";
import koActivity from "./ko/activity.json";
import koSkills from "./ko/skills.json";
import koWorkspaces from "./ko/workspaces.json";
import koRuns from "./ko/runs.json";

// English translations
import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enNav from "./en/nav.json";
import enDashboard from "./en/dashboard.json";
import enAgents from "./en/agents.json";
import enIssues from "./en/issues.json";
import enProjects from "./en/projects.json";
import enGoals from "./en/goals.json";
import enRoutines from "./en/routines.json";
import enSettings from "./en/settings.json";
import enApprovals from "./en/approvals.json";
import enCosts from "./en/costs.json";
import enPlugins from "./en/plugins.json";
import enOnboarding from "./en/onboarding.json";
import enInbox from "./en/inbox.json";
import enOrg from "./en/org.json";
import enActivity from "./en/activity.json";
import enSkills from "./en/skills.json";
import enWorkspaces from "./en/workspaces.json";
import enRuns from "./en/runs.json";

const resources = {
  ko: {
    common: koCommon,
    auth: koAuth,
    nav: koNav,
    dashboard: koDashboard,
    agents: koAgents,
    issues: koIssues,
    projects: koProjects,
    goals: koGoals,
    routines: koRoutines,
    settings: koSettings,
    approvals: koApprovals,
    costs: koCosts,
    plugins: koPlugins,
    onboarding: koOnboarding,
    inbox: koInbox,
    org: koOrg,
    activity: koActivity,
    skills: koSkills,
    workspaces: koWorkspaces,
    runs: koRuns,
  },
  en: {
    common: enCommon,
    auth: enAuth,
    nav: enNav,
    dashboard: enDashboard,
    agents: enAgents,
    issues: enIssues,
    projects: enProjects,
    goals: enGoals,
    routines: enRoutines,
    settings: enSettings,
    approvals: enApprovals,
    costs: enCosts,
    plugins: enPlugins,
    onboarding: enOnboarding,
    inbox: enInbox,
    org: enOrg,
    activity: enActivity,
    skills: enSkills,
    workspaces: enWorkspaces,
    runs: enRuns,
  },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: "ko",
    fallbackLng: "ko",
    defaultNS: "common",
    ns: [
      "common",
      "auth",
      "nav",
      "dashboard",
      "agents",
      "issues",
      "projects",
      "goals",
      "routines",
      "settings",
      "approvals",
      "costs",
      "plugins",
      "onboarding",
      "inbox",
      "org",
      "activity",
      "skills",
      "workspaces",
      "runs",
    ],
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
