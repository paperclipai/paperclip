type CompanySettingsCopyLocale = string | null | undefined;

const companySettingsCopy = {
  en: {
    title: "Company preferences",
    company: "Company",
    settings: "Preferences",
    noCompanySelected: "No company selected. Select a company from the switcher above.",
    general: "General",
    appearance: "Appearance",
    companyName: "Company name",
    companyNameHint: "The display name for your company.",
    description: "Description",
    descriptionHint: "Optional description shown in the company profile.",
    descriptionPlaceholder: "Optional company description",
    logo: "Logo",
    logoHint: "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.",
    removeLogo: "Remove logo",
    removingLogo: "Removing...",
    logoUploadFailed: "Logo upload failed",
    uploadingLogo: "Uploading logo...",
    brandColor: "Brand color",
    brandColorHint: "Sets the hue for the company icon. Leave empty for auto-generated color.",
    auto: "Auto",
    clear: "Clear",
    saveChanges: "Save changes",
    saving: "Saving...",
    saved: "Saved",
    failedToSave: "Failed to save",
    hiring: "Hiring",
    requireBoardApproval: "Require board approval for new hires",
    requireBoardApprovalHint: "New agent hires stay pending until approved by board.",
    feedbackSharing: "Feedback Sharing",
    feedbackSharingLabel: "Allow sharing voted AI outputs with Paperclip Labs",
    feedbackSharingHint: "Only AI-generated outputs you explicitly vote on are eligible for feedback sharing.",
    feedbackSharingDescription:
      "Votes are always saved locally. This setting controls whether voted AI outputs may also be marked for sharing with Paperclip Labs.",
    feedbackEnabled: "Feedback sharing enabled",
    feedbackDisabled: "Feedback sharing disabled",
    failedToUpdateFeedbackSharing: "Failed to update feedback sharing",
    unknownError: "Unknown error",
    termsVersion: "Terms version",
    readTermsOfService: "Read our terms of service",
    invites: "Invites",
    inviteDescription: "Generate an OpenClaw agent invite snippet.",
    inviteHint: "Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt.",
    generatingInvite: "Generating...",
    generateInvitePrompt: "Generate OpenClaw Invite Prompt",
    invitePromptTitle: "OpenClaw Invite Prompt",
    invitePromptIntro: "You're invited to join a Paperclip organization.",
    invitePromptUrlsHeading: "The URLs you should try are:",
    invitePromptConnectivityHeading: "Connectivity guidance:",
    invitePromptConnectivityBody:
      "If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.",
    invitePromptConnectivityVerify:
      "Verify the hostname works from your runtime with: GET <base-url>/api/health",
    invitePromptConnectivityNoCandidates:
      "No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.",
    invitePromptSuggestedStepsHeading: "Suggested steps:",
    invitePromptSuggestedSteps: [
      "choose a hostname that resolves to the Paperclip host from your runtime",
      "run: pnpm paperclipai allowed-hostname <host>",
      "restart Paperclip",
      "verify with: curl -fsS http://<host>:3100/api/health",
      "regenerate this invite snippet",
    ],
    invitePromptReachableFallback:
      "If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.",
    invitePromptReachableCommand: "Suggested command:",
    invitePromptReachableVerify: "Then verify with: curl -fsS <base-url>/api/health",
    invitePromptAgentName:
      'For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.',
    invitePromptGatewayUrl:
      "You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.",
    invitePromptResolutionPrefix:
      "You MUST test Paperclip-to-gateway reachability, call:",
    invitePromptResolutionSuffix:
      "(using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it.",
    invitePromptOpenClawGatewayTitle: "This onboarding flow is for OpenClaw Gateway.",
    invitePromptOpenClawGatewayAdapter: 'Use `adapterType: "openclaw_gateway"`.',
    invitePromptOpenClawGatewayUrl:
      "Use `agentDefaultsPayload.url` as your `ws://` or `wss://` gateway URL.",
    invitePromptOpenClawGatewayToken:
      'Use `agentDefaultsPayload.headers["x-openclaw-token"]` with your gateway token.',
    invitePromptOpenClawGatewayLegacyToken:
      'Legacy accepted: `agentDefaultsPayload.headers["x-openclaw-auth"]`.',
    invitePromptOpenClawGatewayDeviceAuth:
      "Keep device auth enabled (recommended). If `devicePrivateKeyPem` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.",
    invitePromptOpenClawGatewayDisableDeviceAuth:
      "Only use `disableDeviceAuth=true` for special environments where pairing cannot be completed.",
    invitePromptOpenClawGatewayNoHooks:
      "Do NOT use `/v1/responses` or `/hooks/*` in this join flow.",
    invitePromptOpenClawGatewayPreStep:
      'Before you do anything, please respond to your user that you understand the instructions and you\'re going to work on them. Then do the step above in another session called "paperclip-onboarding" and then tell your user when you\'re done. Update your user in intermediate steps along the way so they know what\'s going on.',
    invitePromptOpenClawGatewayPostStep:
      "Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.",
    copied: "Copied",
    copySnippet: "Copy snippet",
    copiedSnippet: "Copied snippet",
    failedToCreateInvite: "Failed to create invite",
    companyPackages: "Company Packages",
    companyPackagesDescription: "Import and export have moved to dedicated pages accessible from the",
    orgChart: "Org Chart",
    companyPackagesDescriptionSuffix: "header.",
    export: "Export",
    import: "Import",
    dangerZone: "Danger Zone",
    archiveDescription: "Archive this company to hide it from the sidebar. This persists in the database.",
    archiving: "Archiving...",
    alreadyArchived: "Already archived",
    archiveCompany: "Archive company",
    failedToArchiveCompany: "Failed to archive company",
  },
  "zh-CN": {
    title: "公司设置",
    company: "公司",
    settings: "设置",
    noCompanySelected: "尚未选择公司。请先从上方切换器选择一个公司。",
    general: "常规",
    appearance: "外观",
    companyName: "公司名称",
    companyNameHint: "用于展示的公司名称。",
    description: "描述",
    descriptionHint: "展示在公司资料中的可选描述。",
    descriptionPlaceholder: "可选的公司描述",
    logo: "Logo",
    logoHint: "上传 PNG、JPEG、WEBP、GIF 或 SVG 格式的 Logo 图片。",
    removeLogo: "移除 Logo",
    removingLogo: "移除中...",
    logoUploadFailed: "Logo 上传失败",
    uploadingLogo: "正在上传 Logo...",
    brandColor: "品牌色",
    brandColorHint: "设置公司图标的主色调。留空时将自动生成颜色。",
    auto: "自动",
    clear: "清空",
    saveChanges: "保存更改",
    saving: "保存中...",
    saved: "已保存",
    failedToSave: "保存失败",
    hiring: "招聘",
    requireBoardApproval: "新雇员需经董事会批准",
    requireBoardApprovalHint: "新智能体的招聘请求会保持待处理状态，直到董事会批准。",
    feedbackSharing: "反馈共享",
    feedbackSharingLabel: "允许与 Paperclip Labs 共享你投票过的 AI 输出",
    feedbackSharingHint: "只有你明确投票过的 AI 生成内容，才会被纳入反馈共享范围。",
    feedbackSharingDescription: "投票记录始终只会保存在本地。此设置决定投票过的 AI 输出是否也会被标记为可与 Paperclip Labs 共享。",
    feedbackEnabled: "已开启反馈共享",
    feedbackDisabled: "已关闭反馈共享",
    failedToUpdateFeedbackSharing: "更新反馈共享设置失败",
    unknownError: "未知错误",
    termsVersion: "条款版本",
    readTermsOfService: "阅读我们的服务条款",
    invites: "邀请",
    inviteDescription: "生成 OpenClaw 智能体邀请片段。",
    inviteHint: "创建一个短时有效的 OpenClaw 智能体邀请，并生成可直接复制的提示词。",
    generatingInvite: "生成中...",
    generateInvitePrompt: "生成 OpenClaw 邀请提示词",
    invitePromptTitle: "OpenClaw 邀请提示词",
    invitePromptIntro: "你受邀加入一个 Paperclip 组织。",
    invitePromptUrlsHeading: "你应该尝试的 URL 如下：",
    invitePromptConnectivityHeading: "连通性指导：",
    invitePromptConnectivityBody:
      "如果你运行的机器与 Paperclip 不同，Paperclip 必须可以通过上方使用的某个主机名访问到。",
    invitePromptConnectivityVerify: "请在你的运行环境中用以下命令验证主机名可用：GET <base-url>/api/health",
    invitePromptConnectivityNoCandidates:
      "当前没有可用的候选 URL。请让用户在 Paperclip 中配置一个可访问的主机名，然后重试。",
    invitePromptSuggestedStepsHeading: "建议步骤：",
    invitePromptSuggestedSteps: [
      "选择一个能从你的运行环境解析到 Paperclip 主机的主机名",
      "运行：pnpm paperclipai allowed-hostname <host>",
      "重启 Paperclip",
      "使用以下命令验证：curl -fsS http://<host>:3100/api/health",
      "重新生成此邀请片段",
    ],
    invitePromptReachableFallback:
      "如果都无法访问，请让用户在 Paperclip 中添加一个可访问的主机名，重启后再重试。",
    invitePromptReachableCommand: "建议命令：",
    invitePromptReachableVerify: "然后用以下命令验证：curl -fsS <base-url>/api/health",
    invitePromptAgentName:
      '对于“agentName”，直接使用你自己的智能体名称（OpenClaw 或你的实际名称）即可。',
    invitePromptGatewayUrl:
      "你还需要提供一个 Paperclip 可访问的 gateway URL。请检查你的配置并填入该 URL。",
    invitePromptResolutionPrefix:
      "你必须测试 Paperclip 到 gateway 的连通性，请调用：",
    invitePromptResolutionSuffix:
      "（请使用上面验证可用的主机名）。不要假设你的 172.x 一定能从 Paperclip 访问到。请进行测试。",
    invitePromptOpenClawGatewayTitle: "此接入流程适用于 OpenClaw Gateway。",
    invitePromptOpenClawGatewayAdapter: '使用 `adapterType: "openclaw_gateway"`。',
    invitePromptOpenClawGatewayUrl:
      "将 `agentDefaultsPayload.url` 作为你的 `ws://` 或 `wss://` gateway URL。",
    invitePromptOpenClawGatewayToken:
      '使用 `agentDefaultsPayload.headers["x-openclaw-token"]` 携带你的 gateway token。',
    invitePromptOpenClawGatewayLegacyToken:
      '兼容旧字段：`agentDefaultsPayload.headers["x-openclaw-auth"]`。',
    invitePromptOpenClawGatewayDeviceAuth:
      "建议保持设备认证开启。如果省略 `devicePrivateKeyPem`，Paperclip 会在加入时自动生成并持久化，以便配对审批保持稳定。",
    invitePromptOpenClawGatewayDisableDeviceAuth:
      "仅在无法完成配对的特殊环境中使用 `disableDeviceAuth=true`。",
    invitePromptOpenClawGatewayNoHooks:
      "在此加入流程中不要使用 `/v1/responses` 或 `/hooks/*`。",
    invitePromptOpenClawGatewayPreStep:
      '在做任何事情之前，请先回复用户你已经理解这些指令，并且会按要求处理。然后在一个名为 "paperclip-onboarding" 的新会话中执行上面的步骤，完成后再告诉用户。过程中请保持阶段性更新，让用户知道进展。',
    invitePromptOpenClawGatewayPostStep:
      "当你连接到 Paperclip（完成密钥交换等）后，务必查看并遵循他们提供的 onboarding.txt 中的接入说明。",
    copied: "已复制",
    copySnippet: "复制片段",
    copiedSnippet: "已复制片段",
    failedToCreateInvite: "创建邀请失败",
    companyPackages: "公司包",
    companyPackagesDescription: "导入和导出已迁移到独立页面，可从",
    orgChart: "组织架构",
    companyPackagesDescriptionSuffix: "页头进入。",
    export: "导出",
    import: "导入",
    dangerZone: "危险区域",
    archiveDescription: "归档此公司后，它将从侧边栏中隐藏。此操作会持久保存到数据库。",
    archiving: "归档中...",
    alreadyArchived: "已归档",
    archiveCompany: "归档公司",
    failedToArchiveCompany: "归档公司失败",
  },
} as const;

function resolveLocale(locale: CompanySettingsCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getCompanySettingsCopy(locale: CompanySettingsCopyLocale) {
  return companySettingsCopy[resolveLocale(locale)];
}

export function formatFeedbackSharingStatus({
  locale,
  enabledAt,
  enabledBy,
}: {
  locale: CompanySettingsCopyLocale;
  enabledAt: string | null;
  enabledBy: string | null;
}) {
  if (!enabledAt) return locale === "zh-CN" ? "当前未启用共享。" : "Sharing is currently disabled.";
  return locale === "zh-CN"
    ? `启用时间 ${enabledAt}${enabledBy ? `，操作者 ${enabledBy}` : ""}`
    : `Enabled ${enabledAt}${enabledBy ? ` by ${enabledBy}` : ""}`;
}

export function formatArchiveCompanyConfirmation(companyName: string, locale: CompanySettingsCopyLocale) {
  return locale === "zh-CN"
    ? `确定要归档公司“${companyName}”吗？归档后它会从侧边栏中隐藏。`
    : `Archive company "${companyName}"? It will be hidden from the sidebar.`;
}

export function formatOpenClawInvitePrompt({
  locale,
  onboardingTextUrl,
  connectionCandidates,
  testResolutionUrl,
}: {
  locale: CompanySettingsCopyLocale;
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
}) {
  const copy = getCompanySettingsCopy(locale);
  const candidateUrls = buildCandidateOnboardingUrls({
    onboardingTextUrl,
    connectionCandidates,
  });
  const resolutionTestUrl = buildResolutionTestUrl({
    onboardingTextUrl,
    testResolutionUrl,
  });
  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((url) => `- ${url}`).join("\n")
      : copy.invitePromptConnectivityNoCandidates;

  const connectivityBlock =
    candidateUrls.length === 0
      ? [
          copy.invitePromptSuggestedStepsHeading,
          ...copy.invitePromptSuggestedSteps.map((step) => `- ${step}`),
        ].join("\n")
      : [
          copy.invitePromptReachableFallback,
          copy.invitePromptReachableCommand,
          `- pnpm paperclipai allowed-hostname <host>`,
          copy.invitePromptReachableVerify,
        ].join("\n");

  const resolutionLine = resolutionTestUrl
    ? `\n${copy.invitePromptResolutionPrefix} ${resolutionTestUrl}?url=<urlencoded-gateway-url> ${copy.invitePromptResolutionSuffix} `
    : "";

  const openClawGatewaySection = [
    copy.invitePromptOpenClawGatewayTitle,
    `- ${copy.invitePromptOpenClawGatewayAdapter}`,
    `- ${copy.invitePromptOpenClawGatewayUrl}`,
    `- ${copy.invitePromptOpenClawGatewayToken}`,
    `- ${copy.invitePromptOpenClawGatewayLegacyToken}`,
    `- ${copy.invitePromptOpenClawGatewayDeviceAuth}`,
    `- ${copy.invitePromptOpenClawGatewayDisableDeviceAuth}`,
    `- ${copy.invitePromptOpenClawGatewayNoHooks}`,
    "",
    copy.invitePromptOpenClawGatewayPreStep,
    "",
    copy.invitePromptOpenClawGatewayPostStep,
  ].join("\n");

  return [
    copy.invitePromptIntro,
    "",
    copy.invitePromptUrlsHeading,
    candidateList,
    "",
    copy.invitePromptConnectivityHeading,
    copy.invitePromptConnectivityBody,
    copy.invitePromptConnectivityVerify,
    "",
    connectivityBlock,
    "",
    copy.invitePromptAgentName,
    copy.invitePromptGatewayUrl + resolutionLine,
    "",
    "---",
    "",
    openClawGatewaySection,
    "",
  ].join("\n");
}

function buildCandidateOnboardingUrls(input: {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
}) {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: {
  onboardingTextUrl: string;
  testResolutionUrl?: string | null;
}) {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
