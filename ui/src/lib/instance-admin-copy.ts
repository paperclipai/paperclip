type InstanceAdminCopyLocale = string | null | undefined;

const instanceAdminCopy = {
  en: {
    company: "Company",
    instanceSettings: "Instance Settings",
    heartbeats: {
      title: "Scheduled heartbeats",
      description: "Agents with a timer heartbeat enabled across all of your companies.",
      loading: "Loading scheduler heartbeats...",
      failedLoad: "Failed to load scheduler heartbeats.",
      failedUpdateHeartbeat: "Failed to update heartbeat.",
      failedDisableAllHeartbeats: "Failed to disable all heartbeats.",
      unknownError: "Unknown error",
      active: "active",
      disabled: "disabled",
      company: "company",
      companies: "companies",
      disableAll: "Disable All",
      disabling: "Disabling...",
      noMatches: "No scheduler heartbeats match the current criteria.",
      on: "On",
      off: "Off",
      never: "never",
      fullAgentConfig: "Full agent config",
      enableTimerHeartbeat: "Enable Timer Heartbeat",
      disableTimerHeartbeat: "Disable Timer Heartbeat",
    },
    general: {
      toggleCensorAria: "Toggle username log censoring",
      toggleKeyboardAria: "Toggle keyboard shortcuts",
      backupRetention: "Backup retention",
      backupRetentionDescription:
        "Configure how long to keep automatic database backups at each tier. Daily backups are kept in full, then thinned to one per week and one per month. Backups are compressed with gzip.",
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      day: "day",
      days: "days",
      week: "week",
      weeks: "weeks",
      month: "month",
      months: "months",
    },
    experimental: {
      toggleIsolatedWorkspacesAria: "Toggle isolated workspaces experimental setting",
      toggleAutoRestartAria: "Toggle guarded dev-server auto-restart",
    },
    plugins: {
      breadcrumbSettings: "Admin",
      breadcrumbPlugins: "Plugin center",
      managerTitle: "Plugin center",
      installPlugin: "Install a plugin",
      installPluginTitle: "Install a plugin",
      installPluginDescription: "Enter the npm package name of the plugin you wish to install.",
      npmPackageName: "npm Package Name",
      install: "Install",
      installing: "Installing...",
      cancel: "Cancel",
      pluginsAlpha: "Plugins are alpha.",
      pluginsAlphaDescription:
        "The plugin runtime and API surface are still changing. Expect breaking changes while this feature settles.",
      availablePlugins: "Available Plugins",
      examplesBadge: "Examples",
      exampleBadge: "Example",
      loadingExamples: "Loading bundled examples...",
      failedToLoadExamples: "Failed to load bundled examples.",
      noExamples: "No bundled example plugins were found in this checkout.",
      notInstalled: "Not installed",
      enable: "Enable",
      disable: "Disable",
      openSettings: "Open Settings",
      review: "Review",
      installExample: "Install Example",
      installedPlugins: "Installed Plugins",
      noPluginsInstalled: "No plugins installed",
      installPluginHint: "Install a plugin to extend functionality.",
      noDescriptionProvided: "No description provided.",
      pluginError: "Plugin error",
      viewFullError: "View full error",
      configure: "Configure",
      uninstall: "Uninstall",
      uninstalling: "Uninstalling...",
      uninstallPluginTitle: "Uninstall Plugin",
      errorDetailsTitle: "Error Details",
      whatErrored: "What errored",
      fullErrorOutput: "Full error output",
      close: "Close",
      loadingPlugins: "Loading plugins...",
      failedToLoadPlugins: "Failed to load plugins.",
      pluginDetailsFallback: "Plugin Details",
      loadingPluginDetails: "Loading plugin details...",
      configurationTab: "Configuration",
      statusTab: "Status",
      about: "About",
      description: "Description",
      author: "Author",
      categories: "Categories",
      none: "None",
      settings: "Settings",
      noSettingsRequired: "This plugin does not require any settings.",
      runtimeDashboard: "Runtime Dashboard",
      runtimeDashboardDescription: "Worker process, scheduled jobs, and webhook deliveries",
      workerProcess: "Worker Process",
      status: "Status",
      pid: "PID",
      uptime: "Uptime",
      pendingRpcs: "Pending RPCs",
      crashes: "Crashes",
      lastCrash: "Last Crash",
      noWorkerProcess: "No worker process registered.",
      recentJobRuns: "Recent Job Runs",
      noJobRuns: "No job runs recorded yet.",
      recentWebhookDeliveries: "Recent Webhook Deliveries",
      noWebhookDeliveries: "No webhook deliveries recorded yet.",
      lastChecked: "Last checked",
      runtimeUnavailable: "Runtime diagnostics are unavailable right now.",
      recentLogs: "Recent Logs",
      healthStatus: "Health Status",
      checkingHealth: "Checking health...",
      overall: "Overall",
      lifecycle: "Lifecycle",
      healthChecksWhenReady: "Health checks run once the plugin is ready.",
      details: "Details",
      pluginId: "Plugin ID",
      pluginKey: "Plugin Key",
      npmPackage: "NPM Package",
      version: "Version",
      permissions: "Permissions",
      noSpecialPermissions: "No special permissions requested.",
      loadingConfiguration: "Loading configuration...",
      configurationSaved: "Configuration saved.",
      configurationSaveFailed: "Failed to save configuration.",
      configurationTestPassed: "Configuration test passed.",
      configurationTestFailed: "Configuration test failed.",
      saveConfiguration: "Save Configuration",
      savingConfiguration: "Saving...",
      testConfiguration: "Test Configuration",
      testingConfiguration: "Testing...",
      pluginInstalledSuccess: "Plugin installed successfully",
      pluginInstallFailed: "Failed to install plugin",
      pluginUninstalledSuccess: "Plugin uninstalled successfully",
      pluginUninstallFailed: "Failed to uninstall plugin",
      pluginEnabled: "Plugin enabled",
      pluginEnableFailed: "Failed to enable plugin",
      pluginDisabled: "Plugin disabled",
      pluginDisableFailed: "Failed to disable plugin",
      defaultErrorSummary: "Plugin entered an error state without a stored error message.",
      noErrorSummaryAvailable: "No error summary available.",
      noStoredErrorMessage: "No stored error message.",
    },
    adapters: {
      breadcrumbSettings: "Admin",
      breadcrumbAdapters: "Adapter center",
      managerTitle: "Adapter center",
      alphaBadge: "Alpha",
      installAdapter: "Install Adapter",
      installAdapterTitle: "Install External Adapter",
      installAdapterDescription:
        "Add an adapter from npm or a local path. The adapter package must export createServerAdapter().",
      sourceNpmPackage: "npm package",
      sourceLocalPath: "Local path",
      pathToAdapterPackage: "Path to adapter package",
      localPathPlaceholder: "/mnt/e/Projects/my-adapter  or  E:\\Projects\\my-adapter",
      localPathHint: "Accepts Linux, WSL, and Windows paths. Windows paths are auto-converted.",
      packageName: "Package Name",
      packageNamePlaceholder: "my-paperclip-adapter",
      versionOptional: "Version (optional)",
      versionPlaceholder: "latest",
      cancel: "Cancel",
      install: "Install",
      installing: "Installing...",
      removing: "Removing...",
      externalAdaptersAlpha: "External adapters are alpha.",
      externalAdaptersAlphaDescription:
        "The adapter plugin system is under active development. APIs and storage format may change. Use the power icon to hide adapters from agent menus without removing them.",
      externalAdapters: "External Adapters",
      builtInAdapters: "Built-in Adapters",
      noExternalAdaptersInstalled: "No external adapters installed",
      noExternalAdaptersHint: "Install an adapter package to extend model support.",
      noBuiltInAdaptersFound: "No built-in adapters found.",
      externalBadge: "External",
      builtInBadge: "Built-in",
      installedFromLocalPath: "Installed from local path",
      installedFromNpm: "Installed from npm",
      overridesBuiltin: "Overrides built-in",
      hiddenFromMenus: "Hidden from menus",
      reinstallAdapter: "Reinstall adapter",
      reinstallAdapterHint: "pull latest from npm",
      reloadAdapter: "Reload adapter",
      reloadAdapterHint: "hot-swap",
      showInMenus: "Show in agent menus",
      hideFromMenus: "Hide from agent menus",
      removeAdapter: "Remove adapter",
      unknownVersion: "unknown",
      checkingVersion: "checking...",
      unavailableVersion: "unavailable",
      alreadyLatest: "Already on the latest version.",
      reinstalling: "Reinstalling...",
      reinstall: "Reinstall",
      package: "Package",
      current: "Current",
      latestOnNpm: "Latest on npm",
      loadingAdapters: "Loading adapters...",
      adapterInstalled: "Adapter installed",
      installFailed: "Install failed",
      adapterRemoved: "Adapter removed",
      removalFailed: "Removal failed",
      toggleFailed: "Toggle failed",
      overrideToggleFailed: "Override toggle failed",
      adapterReloaded: "Adapter reloaded",
      reloadFailed: "Reload failed",
      adapterReinstalled: "Adapter reinstalled",
      reinstallFailed: "Reinstall failed",
      pauseExternalOverride: "Pause external override",
      resumeExternalOverride: "Resume external override",
      overridePaused: "Override paused",
      removeAdapterTitle: "Remove Adapter",
    },
  },
  "zh-CN": {
    company: "公司",
    instanceSettings: "实例设置",
    heartbeats: {
      title: "调度心跳",
      description: "查看所有公司中启用了定时心跳的智能体。",
      loading: "正在加载调度心跳…",
      failedLoad: "加载调度心跳失败。",
      failedUpdateHeartbeat: "更新心跳失败。",
      failedDisableAllHeartbeats: "停用全部心跳失败。",
      unknownError: "未知错误",
      active: "启用",
      disabled: "停用",
      company: "公司",
      companies: "公司",
      disableAll: "全部停用",
      disabling: "停用中...",
      noMatches: "当前条件下没有匹配的调度心跳。",
      on: "开启",
      off: "关闭",
      never: "从未",
      fullAgentConfig: "完整智能体配置",
      enableTimerHeartbeat: "启用定时心跳",
      disableTimerHeartbeat: "停用定时心跳",
    },
    general: {
      toggleCensorAria: "切换用户名日志脱敏",
      toggleKeyboardAria: "切换键盘快捷键",
      backupRetention: "备份保留策略",
      backupRetentionDescription:
        "配置自动数据库备份在各级别中的保留时长。每日备份会完整保留，然后逐步收敛为每周一份和每月一份。备份会使用 gzip 压缩。",
      daily: "每日",
      weekly: "每周",
      monthly: "每月",
      day: "天",
      days: "天",
      week: "周",
      weeks: "周",
      month: "个月",
      months: "个月",
    },
    experimental: {
      toggleIsolatedWorkspacesAria: "切换独立工作区实验功能",
      toggleAutoRestartAria: "切换开发服务器自动重启实验功能",
    },
    plugins: {
      breadcrumbSettings: "设置",
      breadcrumbPlugins: "插件",
      managerTitle: "插件管理",
      installPlugin: "安装插件",
      installPluginTitle: "安装插件",
      installPluginDescription: "输入要安装的插件 npm 包名。",
      npmPackageName: "npm 包名",
      install: "安装",
      installing: "安装中...",
      cancel: "取消",
      pluginsAlpha: "插件功能仍处于 Alpha 阶段。",
      pluginsAlphaDescription: "插件运行时和 API 表面仍在持续变化中，当前阶段可能出现不兼容变更。",
      availablePlugins: "可用插件",
      examplesBadge: "示例",
      exampleBadge: "示例",
      loadingExamples: "正在加载内置示例...",
      failedToLoadExamples: "加载内置示例失败。",
      noExamples: "当前检出中未找到内置示例插件。",
      notInstalled: "未安装",
      enable: "启用",
      disable: "停用",
      openSettings: "打开设置",
      review: "查看",
      installExample: "安装示例",
      installedPlugins: "已安装插件",
      noPluginsInstalled: "尚未安装任何插件",
      installPluginHint: "安装插件以扩展功能。",
      noDescriptionProvided: "暂无描述。",
      pluginError: "插件错误",
      viewFullError: "查看完整错误",
      configure: "配置",
      uninstall: "卸载",
      uninstalling: "卸载中...",
      uninstallPluginTitle: "卸载插件",
      errorDetailsTitle: "错误详情",
      whatErrored: "出错内容",
      fullErrorOutput: "完整错误输出",
      close: "关闭",
      loadingPlugins: "正在加载插件...",
      failedToLoadPlugins: "加载插件失败。",
      pluginDetailsFallback: "插件详情",
      loadingPluginDetails: "正在加载插件详情...",
      configurationTab: "配置",
      statusTab: "状态",
      about: "关于",
      description: "描述",
      author: "作者",
      categories: "分类",
      none: "无",
      settings: "设置",
      noSettingsRequired: "此插件不需要额外设置。",
      runtimeDashboard: "运行面板",
      runtimeDashboardDescription: "工作进程、计划任务与 Webhook 投递情况",
      workerProcess: "工作进程",
      status: "状态",
      pid: "PID",
      uptime: "运行时长",
      pendingRpcs: "待处理 RPC",
      crashes: "崩溃次数",
      lastCrash: "最近一次崩溃",
      noWorkerProcess: "尚未注册工作进程。",
      recentJobRuns: "最近任务运行",
      noJobRuns: "尚未记录任务运行。",
      recentWebhookDeliveries: "最近 Webhook 投递",
      noWebhookDeliveries: "尚未记录 Webhook 投递。",
      lastChecked: "最近检查",
      runtimeUnavailable: "当前无法获取运行诊断信息。",
      recentLogs: "最近日志",
      healthStatus: "健康状态",
      checkingHealth: "正在检查健康状态...",
      overall: "总体",
      lifecycle: "生命周期",
      healthChecksWhenReady: "插件就绪后才会运行健康检查。",
      details: "详情",
      pluginId: "插件 ID",
      pluginKey: "插件键",
      npmPackage: "NPM 包",
      version: "版本",
      permissions: "权限",
      noSpecialPermissions: "未请求额外权限。",
      loadingConfiguration: "正在加载配置...",
      configurationSaved: "配置已保存。",
      configurationSaveFailed: "保存配置失败。",
      configurationTestPassed: "配置测试通过。",
      configurationTestFailed: "配置测试失败。",
      saveConfiguration: "保存配置",
      savingConfiguration: "保存中...",
      testConfiguration: "测试配置",
      testingConfiguration: "测试中...",
      pluginInstalledSuccess: "插件安装成功",
      pluginInstallFailed: "安装插件失败",
      pluginUninstalledSuccess: "插件卸载成功",
      pluginUninstallFailed: "卸载插件失败",
      pluginEnabled: "插件已启用",
      pluginEnableFailed: "启用插件失败",
      pluginDisabled: "插件已停用",
      pluginDisableFailed: "停用插件失败",
      defaultErrorSummary: "插件进入错误状态，但没有保存错误信息。",
      noErrorSummaryAvailable: "暂无错误摘要。",
      noStoredErrorMessage: "未保存错误信息。",
    },
    adapters: {
      breadcrumbSettings: "设置",
      breadcrumbAdapters: "适配器",
      managerTitle: "适配器管理",
      alphaBadge: "Alpha",
      installAdapter: "安装适配器",
      installAdapterTitle: "安装外部适配器",
      installAdapterDescription:
        "从 npm 或本地路径添加适配器。适配器包必须导出 createServerAdapter()。",
      sourceNpmPackage: "npm 包",
      sourceLocalPath: "本地路径",
      pathToAdapterPackage: "适配器包路径",
      localPathPlaceholder: "/mnt/e/Projects/my-adapter  或  E:\\Projects\\my-adapter",
      localPathHint: "支持 Linux、WSL 和 Windows 路径。Windows 路径会自动转换。",
      packageName: "包名",
      packageNamePlaceholder: "my-paperclip-adapter",
      versionOptional: "版本（可选）",
      versionPlaceholder: "latest",
      cancel: "取消",
      install: "安装",
      installing: "安装中...",
      removing: "移除中...",
      externalAdaptersAlpha: "外部适配器仍处于 Alpha 阶段。",
      externalAdaptersAlphaDescription:
        "适配器插件系统仍在积极开发中，API 和存储格式可能发生变化。可使用电源图标将适配器从智能体菜单中隐藏，而无需移除。",
      externalAdapters: "外部适配器",
      builtInAdapters: "内置适配器",
      noExternalAdaptersInstalled: "尚未安装外部适配器",
      noExternalAdaptersHint: "安装适配器包以扩展模型支持。",
      noBuiltInAdaptersFound: "未找到内置适配器。",
      externalBadge: "外部",
      builtInBadge: "内置",
      installedFromLocalPath: "从本地路径安装",
      installedFromNpm: "从 npm 安装",
      overridesBuiltin: "覆盖内置项",
      hiddenFromMenus: "已从菜单隐藏",
      reinstallAdapter: "重新安装适配器",
      reinstallAdapterHint: "从 npm 拉取最新版本",
      reloadAdapter: "重新加载适配器",
      reloadAdapterHint: "热替换",
      showInMenus: "在智能体菜单中显示",
      hideFromMenus: "从智能体菜单中隐藏",
      removeAdapter: "移除适配器",
      unknownVersion: "未知",
      checkingVersion: "检查中...",
      unavailableVersion: "不可用",
      alreadyLatest: "已经是最新版本。",
      reinstalling: "重新安装中...",
      reinstall: "重新安装",
      package: "包",
      current: "当前版本",
      latestOnNpm: "npm 最新版本",
      loadingAdapters: "正在加载适配器...",
      adapterInstalled: "适配器安装成功",
      installFailed: "安装失败",
      adapterRemoved: "适配器已移除",
      removalFailed: "移除失败",
      toggleFailed: "切换失败",
      overrideToggleFailed: "覆盖切换失败",
      adapterReloaded: "适配器已重新加载",
      reloadFailed: "重新加载失败",
      adapterReinstalled: "适配器已重新安装",
      reinstallFailed: "重新安装失败",
      pauseExternalOverride: "暂停外部覆盖",
      resumeExternalOverride: "恢复外部覆盖",
      overridePaused: "覆盖已暂停",
      removeAdapterTitle: "移除适配器",
    },
  },
} as const;

function resolveLocale(locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getInstanceAdminCopy(locale: InstanceAdminCopyLocale) {
  return instanceAdminCopy[resolveLocale(locale)];
}

export function formatHeartbeatSummary({
  active,
  disabled,
  companies,
  locale,
}: {
  active: number;
  disabled: number;
  companies: number;
  locale: InstanceAdminCopyLocale;
}) {
  const copy = getInstanceAdminCopy(locale);
  if (locale === "zh-CN") {
    return `${active} 个${copy.heartbeats.active} · ${disabled} 个${copy.heartbeats.disabled} · ${companies} 个${copy.heartbeats.company}`;
  }
  return `${active} ${copy.heartbeats.active} · ${disabled} ${copy.heartbeats.disabled} · ${companies} ${companies === 1 ? copy.heartbeats.company : copy.heartbeats.companies}`;
}

export function formatDisableAllHeartbeatsConfirmation(enabledCount: number, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `确定要停用全部 ${enabledCount} 个已启用智能体的定时心跳吗？`;
  }
  return `Disable timer heartbeats for all ${enabledCount} enabled agent${enabledCount === 1 ? "" : "s"}?`;
}

export function formatDisableAllHeartbeatsFailure({
  failures,
  enabled,
  detail,
  locale,
}: {
  failures: number;
  enabled: number;
  detail: string;
  locale: InstanceAdminCopyLocale;
}) {
  if (locale === "zh-CN") {
    return failures === 1
      ? `停用 1 个定时心跳失败：${detail}`
      : `停用 ${enabled} 个定时心跳中的 ${failures} 个失败。首个错误：${detail}`;
  }
  return failures === 1
    ? `Failed to disable 1 timer heartbeat: ${detail}`
    : `Failed to disable ${failures} of ${enabled} timer heartbeats. First error: ${detail}`;
}

export function formatRetentionDays(days: number, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `${days} 天`;
  }
  const copy = getInstanceAdminCopy(locale);
  return `${days} ${days === 1 ? copy.general.day : copy.general.days}`;
}

export function formatRetentionWeeks(weeks: number, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `${weeks} 周`;
  }
  const copy = getInstanceAdminCopy(locale);
  return `${weeks} ${weeks === 1 ? copy.general.week : copy.general.weeks}`;
}

export function formatRetentionMonths(months: number, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `${months} 个月`;
  }
  const copy = getInstanceAdminCopy(locale);
  return `${months} ${months === 1 ? copy.general.month : copy.general.months}`;
}

export function formatHeartbeatInterval(seconds: number, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? `${seconds} 秒` : `${seconds}s`;
}

export function formatInstanceAdminStatusLabel(status: string, locale: InstanceAdminCopyLocale) {
  if (locale !== "zh-CN") return status;
  switch (status) {
    case "ready":
      return "就绪";
    case "error":
      return "错误";
    case "running":
      return "运行中";
    case "stopped":
      return "已停止";
    case "installing":
      return "安装中";
    case "uninstalling":
      return "卸载中";
    case "disabled":
      return "已停用";
    case "enabled":
      return "已启用";
    case "healthy":
      return "健康";
    case "unhealthy":
      return "异常";
    case "success":
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "received":
      return "已接收";
    case "processed":
      return "已处理";
    case "queued":
      return "排队中";
    case "pending":
      return "等待中";
    case "cancelled":
      return "已取消";
    case "warn":
      return "警告";
    case "debug":
      return "调试";
    case "info":
      return "信息";
    default:
      return status;
  }
}

export function formatInstanceAdminJobTriggerLabel(trigger: string, locale: InstanceAdminCopyLocale) {
  if (locale !== "zh-CN") return trigger;
  switch (trigger) {
    case "manual":
      return "手动";
    case "schedule":
      return "计划";
    case "retry":
      return "重试";
    default:
      return trigger;
  }
}

export function formatInstanceAdminUptime(uptimeMs: number | null, locale: InstanceAdminCopyLocale) {
  if (uptimeMs == null) return "—";
  const totalSeconds = Math.floor(uptimeMs / 1000);
  if (locale === "zh-CN") {
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatInstanceAdminDuration(ms: number, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    if (ms < 1000) return `${ms} 毫秒`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${(ms / 60000).toFixed(1)} 分钟`;
  }
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatInstanceAdminRelativeTime(isoString: string, locale: InstanceAdminCopyLocale) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return locale === "zh-CN" ? "刚刚" : "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (locale === "zh-CN") {
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  }
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatPluginLogEntryCount(count: number, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? `最近 ${count} 条日志` : `Last ${count} log entries`;
}

export function formatPluginCrashSummary(consecutive: number, total: number, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN"
    ? `连续 ${consecutive} 次 / 累计 ${total} 次`
    : `${consecutive} consecutive / ${total} total`;
}

export function formatAdapterModelsCount(count: number, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? `${count} 个模型` : `${count} models`;
}

export function formatAdapterInstalledBody(type: string, version: string | null | undefined, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN"
    ? `类型“${type}”已成功注册。${version ? `（v${version}）` : ""}`
    : `Type "${type}" registered successfully.${version ? ` (v${version})` : ""}`;
}

export function formatAdapterReloadedBody(type: string, version: string | null | undefined, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN"
    ? `类型“${type}”已重新加载。${version ? `（v${version}）` : ""}`
    : `Type "${type}" reloaded.${version ? ` (v${version})` : ""}`;
}

export function formatAdapterReinstalledBody(type: string, version: string | null | undefined, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN"
    ? `类型“${type}”已从 npm 更新。${version ? `（v${version}）` : ""}`
    : `Type "${type}" updated from npm.${version ? ` (v${version})` : ""}`;
}

export function formatAdapterOverriddenBy(overriddenBy: string, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? `被 ${overriddenBy} 覆盖` : `Overridden by ${overriddenBy}`;
}

export function formatPluginUninstallDescription(name: string, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN"
    ? `确定要卸载 ${name} 吗？此操作无法撤销。`
    : `Are you sure you want to uninstall ${name}? This action cannot be undone.`;
}

export function formatPluginErrorDetailsDescription(name: string, locale: InstanceAdminCopyLocale) {
  return locale === "zh-CN" ? `${name} 进入了错误状态。` : `${name} hit an error state.`;
}

export function formatAdapterReinstallDescription(packageName: string | null | undefined, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `这将从 npm 拉取 ${packageName ?? "该适配器"} 的最新版本，并热替换当前运行的适配器模块。已有智能体会在下次运行时使用新版本。`;
  }
  return `This will pull the latest version of ${packageName ?? "this adapter"} from npm and hot-swap the running adapter module. Existing agents will use the new version on their next run.`;
}

export function formatAdapterRemoveDescription(type: string, hasPackageName: boolean, locale: InstanceAdminCopyLocale) {
  if (locale === "zh-CN") {
    return `确定要移除 ${type} 适配器吗？它将从适配器存储中注销并删除。${hasPackageName ? " 磁盘上的 npm 包也会被清理。" : ""} 此操作无法撤销。`;
  }
  return `Are you sure you want to remove the ${type} adapter? It will be unregistered and removed from the adapter store.${hasPackageName ? " npm packages will be cleaned up from disk." : ""} This action cannot be undone.`;
}
