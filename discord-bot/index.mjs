import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || "http://localhost:3100";
const SERVICE_TOKEN = process.env.PAPERCLIP_SERVICE_TOKEN;

if (!DISCORD_TOKEN) { console.error("DISCORD_TOKEN required"); process.exit(1); }
if (!SERVICE_TOKEN) { console.error("PAPERCLIP_SERVICE_TOKEN required"); process.exit(1); }

// --- Paperclip API helpers ---

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${SERVICE_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${PAPERCLIP_URL}/api${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return null;
}

// --- Company/Agent discovery ---

// Maps: channelName → { companyId, companyName, ceoAgent }
const companyMap = new Map();
// Maps: companyId → { companyName, ceoAgent, agents }
const companyData = new Map();

async function discoverCompanies() {
  const companies = await api("GET", "/companies");
  const active = companies.filter(c => c.status === "active");

  for (const company of active) {
    const agents = await api("GET", `/companies/${company.id}/agents`);
    const ceo = agents.find(a => a.name.toLowerCase().includes("ceo") && a.status !== "terminated");

    const data = {
      companyId: company.id,
      companyName: company.name,
      prefix: company.issuePrefix,
      ceoAgent: ceo || null,
      agents,
    };

    companyData.set(company.id, data);

    // Map channel names to companies
    // Channels: #moqcai-ceo, #palantir-ceo, #morenada-ceo, etc.
    const slug = company.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    companyMap.set(`${slug}-ceo`, data);
    companyMap.set(`${slug}`, data);

    if (ceo) {
      console.log(`[bot] ${company.name} → CEO: ${ceo.name} (${ceo.id}) | channel: #${slug}-ceo`);
    } else {
      console.log(`[bot] ${company.name} → no CEO agent`);
    }
  }

  console.log(`[bot] Discovered ${active.length} companies, ${[...companyData.values()].filter(d => d.ceoAgent).length} with CEO agents`);
}

function resolveCompany(channel) {
  if (!channel) return null;
  const name = channel.name?.toLowerCase() || "";
  // Try exact match first: #moqcai-ceo → moqcai
  if (companyMap.has(name)) return companyMap.get(name);
  // Try prefix match: #moqcai-ceo → moqcai-ceo
  for (const [key, data] of companyMap) {
    if (name.startsWith(key) || name.includes(key)) return data;
  }
  // Fallback: first company with a CEO
  for (const data of companyData.values()) {
    if (data.ceoAgent) return data;
  }
  return null;
}

async function wakeAgent(agentId, message, discordContext) {
  return api("POST", `/agents/${agentId}/wakeup`, {
    source: "on_demand",
    triggerDetail: "callback",
    reason: "discord_message",
    payload: {
      message,
      responseChannel: "discord",
      discordChannelId: discordContext.channelId,
      discordUserId: discordContext.userId,
    },
  });
}

async function getRunResult(runId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const run = await api("GET", `/heartbeat-runs/${runId}`);
      if (["completed", "failed", "error"].includes(run.status)) return run;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function getAgentStatus(agentId) {
  const agent = await api("GET", `/agents/${agentId}`);
  const state = await api("GET", `/agents/${agentId}/runtime-state`).catch(() => null);
  return { agent, state };
}

// --- Slash commands ---

const commands = [
  new SlashCommandBuilder()
    .setName("ceo")
    .setDescription("Send a message to the CEO agent")
    .addStringOption(opt => opt.setName("message").setDescription("What to tell the CEO").setRequired(true))
    .addStringOption(opt => opt.setName("company").setDescription("Company name (auto-detected from channel if omitted)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Get the CEO agent's current status"),
  new SlashCommandBuilder()
    .setName("agents")
    .setDescription("List all agents in the company"),
  new SlashCommandBuilder()
    .setName("companies")
    .setDescription("List all companies and their CEO channels"),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Create CEO channels for all companies in this server"),
].map(cmd => cmd.toJSON());

// --- Discord client ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("[bot] Slash commands registered");
  } catch (err) {
    console.error("[bot] Failed to register commands:", err.message);
  }

  try { await discoverCompanies(); } catch (err) { console.warn("[bot] Discovery failed:", err.message); }
});

// Handle slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ceo") {
    const message = interaction.options.getString("message");
    const companyHint = interaction.options.getString("company");
    await interaction.deferReply();

    try {
      let data;
      if (companyHint) {
        const slug = companyHint.toLowerCase().replace(/[^a-z0-9]/g, "");
        data = companyMap.get(slug) || companyMap.get(`${slug}-ceo`);
      }
      if (!data) data = resolveCompany(interaction.channel);
      if (!data?.ceoAgent) {
        await interaction.editReply("No CEO agent found for this channel. Use `/companies` to see available companies, or `/setup` to create channels.");
        return;
      }

      const result = await wakeAgent(data.ceoAgent.id, message, {
        channelId: interaction.channelId,
        userId: interaction.user.id,
      });

      if (result?.status === "skipped") {
        await interaction.editReply(`${data.companyName} CEO is paused or unavailable.`);
        return;
      }

      const runId = result?.id || result?.runId;
      await interaction.editReply(`📨 Sent to **${data.companyName} ${data.ceoAgent.name}**. ${runId ? `Run \`${runId.slice(0, 8)}\` started.` : ""} Waiting...`);

      if (runId) {
        const run = await getRunResult(runId);
        if (run) {
          const summary = run.resultSummary || run.summary || "Run completed.";
          const icon = run.status === "completed" ? "✅" : "❌";
          await interaction.followUp(`${icon} **${data.ceoAgent.name}** (${data.companyName}):\n\n${summary.slice(0, 1900)}`);
        } else {
          await interaction.followUp(`⏱️ Still working. Check Paperclip for the full response.`);
        }
      }
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  if (interaction.commandName === "status") {
    await interaction.deferReply();
    try {
      const data = resolveCompany(interaction.channel);
      if (!data?.ceoAgent) { await interaction.editReply("No CEO agent for this channel."); return; }

      const { agent, state } = await getAgentStatus(data.ceoAgent.id);
      const embed = new EmbedBuilder()
        .setTitle(`${data.companyName} — ${agent.name}`)
        .setColor(agent.status === "active" || agent.status === "idle" ? 0x22c55e : 0xef4444)
        .addFields(
          { name: "Status", value: agent.status, inline: true },
          { name: "Adapter", value: agent.adapterType || "?", inline: true },
          { name: "Last Run", value: state?.lastRunStatus || "none", inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  if (interaction.commandName === "agents") {
    await interaction.deferReply();
    try {
      const data = resolveCompany(interaction.channel);
      if (!data) { await interaction.editReply("No company mapped to this channel."); return; }

      const lines = data.agents.map(a => {
        const icon = a.status === "idle" || a.status === "active" ? "🟢" : a.status === "paused" ? "🟡" : "🔴";
        return `${icon} **${a.name}** — ${a.status} (${a.adapterType || "?"})`;
      });
      await interaction.editReply(`**${data.companyName} agents:**\n${lines.join("\n") || "None"}`);
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  if (interaction.commandName === "companies") {
    await interaction.deferReply();
    try {
      if (companyData.size === 0) await discoverCompanies();
      const lines = [...companyData.values()].map(d => {
        const ceo = d.ceoAgent ? `CEO: ${d.ceoAgent.name}` : "no CEO";
        const slug = d.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
        return `• **${d.companyName}** — ${ceo} | channel: \`#${slug}-ceo\``;
      });
      await interaction.editReply(`**Companies:**\n${lines.join("\n")}`);
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  if (interaction.commandName === "setup") {
    await interaction.deferReply();
    try {
      if (companyData.size === 0) await discoverCompanies();
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply("This command only works in a server."); return; }

      const created = [];
      for (const data of companyData.values()) {
        if (!data.ceoAgent) continue;
        const slug = data.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
        const channelName = `${slug}-ceo`;

        const existing = guild.channels.cache.find(c => c.name === channelName);
        if (existing) {
          created.push(`#${channelName} (already exists)`);
          continue;
        }

        await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: `Talk to ${data.companyName}'s CEO agent (${data.ceoAgent.name})`,
        });
        created.push(`#${channelName} ✅`);
      }
      await interaction.editReply(`**Channels created:**\n${created.join("\n") || "No companies with CEO agents found."}`);
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }
});

// Handle @mentions
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const content = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) { await message.reply("What would you like me to tell the CEO?"); return; }

  try {
    const data = resolveCompany(message.channel);
    if (!data?.ceoAgent) {
      await message.reply("No CEO agent mapped to this channel. Use `/setup` to create company channels.");
      return;
    }

    await message.react("📨");
    const result = await wakeAgent(data.ceoAgent.id, content, {
      channelId: message.channelId,
      userId: message.author.id,
    });

    const runId = result?.id || result?.runId;
    if (!runId) { await message.reply(`Sent to **${data.companyName} CEO**. Couldn't track the run.`); return; }

    const run = await getRunResult(runId, 180000);
    if (run) {
      const summary = run.resultSummary || run.summary || "Done.";
      const icon = run.status === "completed" ? "✅" : "❌";
      await message.reply(`${icon} **${data.ceoAgent.name}** (${data.companyName}): ${summary.slice(0, 1900)}`);
    } else {
      await message.reply(`⏱️ ${data.companyName} CEO is still working. Check Paperclip.`);
    }
  } catch (err) {
    await message.reply(`❌ Error: ${err.message}`);
  }
});

client.login(DISCORD_TOKEN);
