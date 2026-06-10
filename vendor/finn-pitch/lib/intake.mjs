// Intake wizard — asks the questions, writes answers.json
import { input, select } from "@inquirer/prompts";
import { writeFileSync } from "node:fs";

export async function runIntake() {
  console.log("\n🎤  Finn Pitch — new deck\n");

  const answers = {};

  answers.clientName = await input({ message: "Client / company name:" });
  answers.clientWebsite = await input({ message: "Company website (optional — grabs their logo):" });

  answers.clientType = await select({
    message: "Who is the audience?",
    choices: [
      { name: "Enterprise buyer", value: "enterprise" },
      { name: "SMB", value: "smb" },
      { name: "Investor", value: "investor" }
    ]
  });

  answers.useCase = await select({
    message: "Primary use case for Finn:",
    choices: [
      { name: "Inbound support", value: "inbound_support" },
      { name: "Receptionist / front desk", value: "receptionist" },
      { name: "Outbound sales", value: "outbound_sales" },
      { name: "Collections / recovery", value: "collections" },
      { name: "Scheduling / reminders", value: "scheduling" },
      { name: "Lead qualification", value: "qualification" },
      { name: "Renewals / retention", value: "renewals" },
      { name: "Surveys / feedback", value: "surveys" }
    ]
  });

  answers.industry = await input({ message: "Client industry / vertical:" });

  answers.region = await select({
    message: "Region (data residency + currency):",
    choices: [
      { name: "India (INR)", value: "india" },
      { name: "US & Intl (USD)", value: "intl" }
    ]
  });

  answers.format = await select({
    message: "Format:",
    choices: [
      { name: "Live pitch (sparse text, I present)", value: "live" },
      { name: "Leave-behind (dense, reads alone)", value: "leavebehind" }
    ]
  });

  answers.length = await select({
    message: "Length:",
    choices: [
      { name: "Short (~10 min)", value: "short" },
      { name: "Standard (~20 min)", value: "standard" },
      { name: "Deep dive (~30 min)", value: "deep" }
    ]
  });

  answers.primaryMetric = await input({
    message: "Metric the client cares most about (cost/call, pickup rate, CSAT, speed):"
  });

  answers.monthlyCalls = await input({
    message: "Approx monthly call volume (for ROI math, e.g. 8000):",
    default: "5000"
  });

  answers.competitor = await input({
    message: "Competitor they're evaluating (blank if none):"
  });

  answers.stage = await select({
    message: "Decision stage:",
    choices: [
      { name: "Cold intro / first meeting", value: "cold" },
      { name: "Active evaluation", value: "eval" },
      { name: "Final decision / closing", value: "closing" }
    ]
  });

  answers.notes = await input({
    message: "Anything else to weave in? (blank to skip):"
  });

  const out = new URL("../answers.json", import.meta.url);
  writeFileSync(out, JSON.stringify(answers, null, 2));
  console.log(`\n✅  Saved answers.json\n`);
  return answers;
}

// allow standalone run
if (import.meta.url === `file://${process.argv[1]}`) runIntake();
