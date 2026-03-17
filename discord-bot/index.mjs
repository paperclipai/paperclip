import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || "http://localhost:3100";
const SERVICE_TOKEN = process.env.PAPERCLIP_SERVICE_TOKEN;

if (!DISCORD_TOKEN) { console.error("DISCORD_TOKEN required"); process.exit(1); }
if (!SERVICE_TOKEN) { console.error("PAPERCLIP_SERVICE_TOKEN required"); process.exit(1); }

// --- Paperclip API ---

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json", "Accept": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${PAPERCLIP_URL}/api${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : null;
}

// --- State ---

const companyMap = new Map();   // channelSlug → companyData
const companyData = new Map();  // companyId → companyData
const approvalMessages = new Map(); // discordMessageId → { approvalId, companyId }
let guildRef = null;

const TERMINAL_STATUSES = new Set(["completed", "succeeded", "failed", "error"]);

// --- Company discovery ---

async function discoverCompanies() {
  const companies = await api("GET", "/companies");
  for (const company of companies.filter(c => c.status === "active")) {
    const agents = await api("GET", `/companies/${company.id}/agents`);
    const ceo = agents.find(a => a.name.toLowerCase().includes("ceo") && a.status !== "terminated");
    const data = { companyId: company.id, companyName: company.name, prefix: company.issuePrefix, ceoAgent: ceo, agents };
    companyData.set(company.id, data);
    const slug = company.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ceo && !companyMap.has(`${slug}-ceo`)) {
      companyMap.set(`${slug}-ceo`, data);
      companyMap.set(slug, data);
    }
    console.log(`[bot] ${company.name} → ${ceo ? `CEO: ${ceo.name} (${ceo.id})` : "no CEO"} | #${slug}-ceo`);
  }
}

function resolveCompany(channel) {
  if (!channel) return null;
  const name = channel.name?.toLowerCase() || "";
  if (companyMap.has(name)) return companyMap.get(name);
  for (const [key, data] of companyMap) {
    if (name.startsWith(key) || name.includes(key)) return data;
  }
  for (const data of companyData.values()) {
    if (data.ceoAgent) return data;
  }
  return null;
}

function findChannelForCompany(guild, companyId) {
  const data = companyData.get(companyId);
  if (!data) return null;
  const slug = data.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return guild?.channels?.cache?.find(c => c.name === `${slug}-ceo`) || null;
}

// --- Wakeup + streaming response ---

async function wakeAgent(agentId, message, discordContext) {
  return api("POST", `/agents/${agentId}/wakeup`, {
    source: "on_demand", triggerDetail: "callback", reason: "discord_message",
    payload: { message, responseChannel: "discord", discordChannelId: discordContext.channelId, discordUserId: discordContext.userId },
  });
}

function extractTextFromJSONL(stdout) {
  const parts = [];
  for (const line of stdout.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "text" && obj.part?.text) parts.push(obj.part.text);
    } catch { /* skip */ }
  }
  return parts.join("");
}

async function streamRunResponse(companyId, agentId, startTime, replyFn, timeoutMs = 300000) {
  const start = Date.now();
  let lastText = "";
  let lastEditTime = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const runs = await api("GET", `/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=3`);
      const run = runs?.find(r => new Date(r.createdAt).getTime() >= startTime - 5000);
      if (!run) { await sleep(2000); continue; }

      // Extract current text from stdout
      const stdout = run.resultJson?.stdout || "";
      const currentText = extractTextFromJSONL(stdout);

      // Stream: update message if text changed (throttle to every 2s)
      if (currentText && currentText !== lastText && Date.now() - lastEditTime > 2000) {
        const truncated = currentText.slice(0, 1900);
        const status = TERMINAL_STATUSES.has(run.status) ? "" : " ⏳";
        try { await replyFn(`${truncated}${status}`); } catch { /* edit failed, continue */ }
        lastText = currentText;
        lastEditTime = Date.now();
      }

      if (TERMINAL_STATUSES.has(run.status)) {
        // Final update
        const finalText = currentText || run.stdoutExcerpt || run.error || "Done.";
        const icon = run.status === "succeeded" || run.status === "completed" ? "✅" : "❌";
        return { text: finalText, icon, run };
      }
    } catch { /* keep polling */ }
    await sleep(3000);
  }
  return { text: "Timed out waiting for response.", icon: "⏱️", run: null };
}

// --- Event polling (delegations, approvals, activity) ---

let lastPollTime = Date.now();

async function pollEvents() {
  if (!guildRef) return;

  for (const [companyId, data] of companyData) {
    const channel = findChannelForCompany(guildRef, companyId);
    if (!channel) continue;

    try {
      // Poll for new approvals
      const approvals = await api("GET", `/companies/${companyId}/approvals?status=pending`);
      for (const approval of approvals || []) {
        if (new Date(approval.createdAt).getTime() < lastPollTime) continue;
        if (approvalMessages.has(approval.id)) continue;

        const embed = new EmbedBuilder()
          .setTitle("🔔 Approval Required")
          .setDescription(approval.title || approval.description || "An agent needs your approval.")
          .setColor(0xf59e0b)
          .addFields(
            { name: "Requested by", value: approval.requestedByAgentName || "Agent", inline: true },
            { name: "Type", value: approval.type || "action", inline: true },
          )
          .setFooter({ text: `React 👍 to approve, 👎 to reject | ID: ${approval.id.slice(0, 8)}` });

        const msg = await channel.send({ embeds: [embed] });
        await msg.react("👍");
        await msg.react("👎");
        approvalMessages.set(msg.id, { approvalId: approval.id, companyId });
        console.log(`[bot] Posted approval ${approval.id.slice(0, 8)} to #${channel.name}`);
      }

      // Poll for recent activity (delegations, assignments)
      const runs = await api("GET", `/companies/${companyId}/heartbeat-runs?limit=5`);
      for (const run of runs || []) {
        if (new Date(run.createdAt).getTime() < lastPollTime) continue;
        if (run.invocationSource === "assignment" && run.status === "queued") {
          const agentName = data.agents.find(a => a.id === run.agentId)?.name || "Agent";
          const ctx = run.contextSnapshot || {};
          const issueId = ctx.issueId;
          const reason = ctx.wakeReason || "assigned";
          if (issueId && reason.includes("assigned")) {
            channel.send(`📋 **${agentName}** picked up task ${data.prefix}-${issueId.slice(0, 4)}... (${reason})`).catch(() => {});
          }
        }
      }
    } catch (err) {
      // Silently skip polling errors
    }
  }

  lastPollTime = Date.now();
}

// --- Scheduled reports ---

function getNextReportTime() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(14, 0, 0, 0); // 9 AM ET / 6 AM PT
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

let nextReport = getNextReportTime();

async function checkScheduledReport() {
  if (Date.now() < nextReport.getTime()) return;
  nextReport = getNextReportTime();

  for (const [companyId, data] of companyData) {
    if (!data.ceoAgent || !guildRef) continue;
    const channel = findChannelForCompany(guildRef, companyId);
    if (!channel) continue;

    try {
      // Wake CEO with report request
      await wakeAgent(data.ceoAgent.id,
        "Generate a daily status report. Summarize: tasks completed today, tasks in progress, blockers, and what's planned for tomorrow. Keep it concise — this goes to Discord.",
        { channelId: channel.id, userId: "scheduled-report" }
      );

      const wakeTime = Date.now();
      const result = await streamRunResponse(companyId, data.ceoAgent.id, wakeTime,
        async (text) => { /* don't stream reports, just wait */ }, 180000);

      if (result.text && result.text !== "Done.") {
        const embed = new EmbedBuilder()
          .setTitle(`📊 Daily Report — ${data.companyName}`)
          .setDescription(result.text.slice(0, 4000))
          .setColor(0x3b82f6)
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(`[bot] Scheduled report failed for ${data.companyName}:`, err.message);
    }
  }
}

// --- File preview ---

async function fetchFilePreview(workspaceId, filePath) {
  try {
    const content = await api("GET", `/files/workspaces/${encodeURIComponent(workspaceId)}/content?path=${encodeURIComponent(filePath)}`);
    if (!content?.content) return null;
    return { path: filePath, content: content.content, type: content.type, size: content.size };
  } catch { return null; }
}

function detectFileMentions(text) {
  const mentions = [];
  // Match @FileName patterns and paperclip-file:// URIs
  const uriPattern = /paperclip-file:\/\/([^/\s)]+)\/([^\s)]+)/g;
  let match;
  while ((match = uriPattern.exec(text)) !== null) {
    mentions.push({ workspaceId: decodeURIComponent(match[1]), filePath: match[2] });
  }
  // Also match natural @mentions of known file patterns
  const namePattern = /@([\w-]+(?:\s[\w-]+)*\.md)/gi;
  while ((match = namePattern.exec(text)) !== null) {
    mentions.push({ workspaceId: "moqcai", filePath: match[1] });
  }
  return mentions;
}

// --- Slash commands ---

const commands = [
  new SlashCommandBuilder().setName("ceo").setDescription("Send a message to the CEO agent")
    .addStringOption(o => o.setName("message").setDescription("What to tell the CEO").setRequired(true))
    .addStringOption(o => o.setName("company").setDescription("Company name (auto-detected from channel)").setRequired(false)),
  new SlashCommandBuilder().setName("status").setDescription("Get the CEO agent's current status"),
  new SlashCommandBuilder().setName("agents").setDescription("List all agents in the company"),
  new SlashCommandBuilder().setName("companies").setDescription("List all companies"),
  new SlashCommandBuilder().setName("setup").setDescription("Create CEO channels for all companies"),
  new SlashCommandBuilder().setName("report").setDescription("Request an immediate status report from the CEO"),
  new SlashCommandBuilder().setName("file").setDescription("Preview a project file")
    .addStringOption(o => o.setName("path").setDescription("File path (e.g. gtm-strategy/HISPANIC_MARKET_GTM.md)").setRequired(true))
    .addStringOption(o => o.setName("workspace").setDescription("Workspace (default: moqcai)").setRequired(false)),
].map(cmd => cmd.toJSON());

// --- Helpers ---

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Discord client ---

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessageReactions],
});

client.once("ready", async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  guildRef = client.guilds.cache.first();

  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("[bot] Slash commands registered");
  } catch (err) { console.error("[bot] Command registration failed:", err.message); }

  try { await discoverCompanies(); } catch (err) { console.warn("[bot] Discovery failed:", err.message); }

  // Start event polling loop (every 30s)
  setInterval(() => pollEvents().catch(e => console.error("[bot] Poll error:", e.message)), 30000);

  // Start scheduled report check (every 5 min)
  setInterval(() => checkScheduledReport().catch(e => console.error("[bot] Report error:", e.message)), 300000);
});

// --- Interaction handler ---

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
      if (!data?.ceoAgent) { await interaction.editReply("No CEO agent found for this channel."); return; }

      const wakeTime = Date.now();
      await wakeAgent(data.ceoAgent.id, message, { channelId: interaction.channelId, userId: interaction.user.id });
      await interaction.editReply(`📨 **${data.ceoAgent.name}** (${data.companyName}) is thinking...`);

      // Stream response back
      const result = await streamRunResponse(data.companyId, data.ceoAgent.id, wakeTime,
        async (text) => { await interaction.editReply(text); });

      await interaction.editReply(`${result.icon} **${data.ceoAgent.name}** (${data.companyName}):\n\n${result.text.slice(0, 1900)}`);
    } catch (err) { await interaction.editReply(`❌ Error: ${err.message}`); }
  }

  if (interaction.commandName === "status") {
    await interaction.deferReply();
    try {
      const data = resolveCompany(interaction.channel);
      if (!data?.ceoAgent) { await interaction.editReply("No CEO agent for this channel."); return; }
      const agent = await api("GET", `/agents/${data.ceoAgent.id}`);
      const state = await api("GET", `/agents/${data.ceoAgent.id}/runtime-state`).catch(() => null);
      const embed = new EmbedBuilder()
        .setTitle(`${data.companyName} — ${agent.name}`)
        .setColor(["active", "idle"].includes(agent.status) ? 0x22c55e : 0xef4444)
        .addFields(
          { name: "Status", value: agent.status, inline: true },
          { name: "Adapter", value: agent.adapterType || "?", inline: true },
          { name: "Last Run", value: state?.lastRunStatus || "none", inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
    } catch (err) { await interaction.editReply(`❌ Error: ${err.message}`); }
  }

  if (interaction.commandName === "agents") {
    await interaction.deferReply();
    try {
      const data = resolveCompany(interaction.channel);
      if (!data) { await interaction.editReply("No company for this channel."); return; }
      const lines = data.agents.map(a => {
        const icon = ["idle", "active"].includes(a.status) ? "🟢" : a.status === "paused" ? "🟡" : "🔴";
        return `${icon} **${a.name}** — ${a.status} (${a.adapterType || "?"})`;
      });
      await interaction.editReply(`**${data.companyName}:**\n${lines.join("\n") || "None"}`);
    } catch (err) { await interaction.editReply(`❌ Error: ${err.message}`); }
  }

  if (interaction.commandName === "companies") {
    await interaction.deferReply();
    try {
      if (companyData.size === 0) await discoverCompanies();
      const lines = [...companyData.values()].map(d => {
        const ceo = d.ceoAgent ? `CEO: ${d.ceoAgent.name}` : "no CEO";
        const slug = d.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
        return `• **${d.companyName}** — ${ceo} | \`#${slug}-ceo\``;
      });
      await interaction.editReply(lines.join("\n") || "No companies.");
    } catch (err) { await interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.commandName === "setup") {
    await interaction.deferReply();
    try {
      if (companyData.size === 0) await discoverCompanies();
      const guild = interaction.guild;
      if (!guild) { await interaction.editReply("Server only."); return; }
      const created = [];
      for (const data of companyData.values()) {
        if (!data.ceoAgent) continue;
        const slug = data.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
        const channelName = `${slug}-ceo`;
        if (guild.channels.cache.find(c => c.name === channelName)) { created.push(`#${channelName} (exists)`); continue; }
        await guild.channels.create({ name: channelName, type: ChannelType.GuildText, topic: `Talk to ${data.companyName}'s CEO (${data.ceoAgent.name})` });
        created.push(`#${channelName} ✅`);
      }
      await interaction.editReply(created.join("\n") || "No companies with CEOs.");
    } catch (err) { await interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.commandName === "report") {
    await interaction.deferReply();
    try {
      const data = resolveCompany(interaction.channel);
      if (!data?.ceoAgent) { await interaction.editReply("No CEO for this channel."); return; }
      const wakeTime = Date.now();
      await wakeAgent(data.ceoAgent.id,
        "Generate a status report NOW. Summarize: open tasks, in-progress work, blockers, and priorities. Be concise — this is for Discord.",
        { channelId: interaction.channelId, userId: interaction.user.id });
      await interaction.editReply(`📊 Generating report from **${data.ceoAgent.name}**...`);
      const result = await streamRunResponse(data.companyId, data.ceoAgent.id, wakeTime,
        async (text) => { await interaction.editReply(`📊 ${text.slice(0, 1900)}`); });
      const embed = new EmbedBuilder()
        .setTitle(`📊 Status Report — ${data.companyName}`)
        .setDescription(result.text.slice(0, 4000))
        .setColor(result.icon === "✅" ? 0x22c55e : 0xef4444)
        .setTimestamp();
      await interaction.editReply({ content: "", embeds: [embed] });
    } catch (err) { await interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.commandName === "file") {
    const filePath = interaction.options.getString("path");
    const workspace = interaction.options.getString("workspace") || "moqcai";
    await interaction.deferReply();
    try {
      const file = await fetchFilePreview(workspace, filePath);
      if (!file) { await interaction.editReply(`File not found: ${filePath}`); return; }
      const preview = file.content.slice(0, 1800);
      const embed = new EmbedBuilder()
        .setTitle(`📄 ${filePath}`)
        .setDescription(`\`\`\`${file.type === "markdown" ? "md" : ""}\n${preview}\n\`\`\``)
        .setColor(0x6366f1)
        .setFooter({ text: `${(file.size / 1024).toFixed(1)}KB | ${workspace}` });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) { await interaction.editReply(`❌ ${err.message}`); }
  }
});

// --- Approval reaction handler ---

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  const approvalInfo = approvalMessages.get(reaction.message.id);
  if (!approvalInfo) return;

  const emoji = reaction.emoji.name;
  if (emoji !== "👍" && emoji !== "👎") return;

  try {
    const endpoint = emoji === "👍" ? "approve" : "reject";
    await api("POST", `/approvals/${approvalInfo.approvalId}/${endpoint}`, {
      comment: `${endpoint === "approve" ? "Approved" : "Rejected"} via Discord by ${user.username}`,
    });

    const statusEmoji = emoji === "👍" ? "✅ Approved" : "❌ Rejected";
    await reaction.message.reply(`${statusEmoji} by ${user.username}`);
    approvalMessages.delete(reaction.message.id);
    console.log(`[bot] Approval ${approvalInfo.approvalId.slice(0, 8)} ${endpoint}ed by ${user.username}`);
  } catch (err) {
    await reaction.message.reply(`Failed to process: ${err.message}`).catch(() => {});
  }
});

// --- @mention handler ---

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // File mention detection in any message
  const fileMentions = detectFileMentions(message.content);
  if (fileMentions.length > 0 && !message.mentions.has(client.user)) {
    for (const fm of fileMentions.slice(0, 2)) {
      const file = await fetchFilePreview(fm.workspaceId, fm.filePath);
      if (file) {
        const preview = file.content.slice(0, 800);
        const embed = new EmbedBuilder()
          .setTitle(`📄 ${fm.filePath}`)
          .setDescription(`\`\`\`${file.type === "markdown" ? "md" : ""}\n${preview}\n\`\`\``)
          .setColor(0x6366f1)
          .setFooter({ text: `${(file.size / 1024).toFixed(1)}KB | ${fm.workspaceId}` });
        await message.reply({ embeds: [embed] }).catch(() => {});
      }
    }
  }

  // Bot @mention → wake CEO
  if (!message.mentions.has(client.user)) return;
  const content = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) { await message.reply("What should I tell the CEO?"); return; }

  try {
    const data = resolveCompany(message.channel);
    if (!data?.ceoAgent) { await message.reply("No CEO for this channel. Use `/setup`."); return; }

    await message.react("📨");
    const wakeTime = Date.now();
    await wakeAgent(data.ceoAgent.id, content, { channelId: message.channelId, userId: message.author.id });

    const statusMsg = await message.reply(`⏳ **${data.ceoAgent.name}** is working...`);
    const result = await streamRunResponse(data.companyId, data.ceoAgent.id, wakeTime,
      async (text) => { await statusMsg.edit(text.slice(0, 1900) + " ⏳").catch(() => {}); }, 180000);

    await statusMsg.edit(`${result.icon} **${data.ceoAgent.name}** (${data.companyName}): ${result.text.slice(0, 1900)}`);
  } catch (err) { await message.reply(`❌ ${err.message}`); }
});

client.login(DISCORD_TOKEN);
