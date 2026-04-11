import type { CompanySkillProjectScanResult } from "@paperclipai/shared";

type CompanySkillsCopyLocale = string | null | undefined;

const companySkillsCopy = {
  en: {
    breadcrumbs: {
      skills: "Skills",
      detail: "Details",
    },
    empty: {
      noCompanySelected: "Select a company to manage skills.",
      selectFile: "Select a file to inspect.",
    },
    sources: {
      skillsShFallback: "skills.sh",
      skillsShManaged: "skills.sh managed",
      githubFallback: "GitHub",
      githubManaged: "GitHub managed",
      urlFallback: "URL",
      urlManaged: "URL managed",
      folderFallback: "Folder",
      folderManaged: "Folder managed",
      paperclipFallback: "Paperclip",
      paperclipManaged: "Paperclip managed",
      catalogFallback: "Catalog",
      catalogManaged: "Catalog managed",
    },
    newSkill: {
      namePlaceholder: "Skill name",
      slugPlaceholder: "optional-shortname",
      descriptionPlaceholder: "Short description",
      cancel: "Cancel",
      create: "Create skill",
      creating: "Creating...",
    },
    list: {
      title: "Skills",
      detail: "Details",
      available: "in library",
      scanWorkspace: "Scan project workspaces for skills",
      filter: "Filter skills",
      sourcePlaceholder: "Paste path, GitHub URL, or skills.sh command",
      add: "Add",
      noMatches: "No skills match this filter.",
      expand: "Expand",
      collapse: "Collapse",
    },
    pane: {
      selectSkill: "Select a skill to inspect its files.",
      remove: "Remove",
      removeSkill: "Remove skill",
      removing: "Removing...",
      edit: "Edit",
      stopEditing: "Stop editing",
      source: "Source",
      pin: "Pin",
      tracking: "tracking",
      key: "Key",
      mode: "Mode",
      editable: "Editable",
      readOnly: "Read only",
      usedBy: "Used by",
      noAgentsAttached: "No agents attached",
      checkForUpdates: "Check for updates",
      installUpdate: "Install update",
      upToDate: "Up to date",
      untracked: "untracked",
      view: "View",
      code: "Code",
      save: "Save",
      saving: "Saving...",
      cancel: "Cancel",
      copiedPath: "Copied path to workspace",
      removeBlocked: "Detach this skill from all agents before removing it.",
    },
    dialogs: {
      removeTitle: "Remove skill",
      removeDescription:
        "Remove this skill from the company library. If any agents still use it, removal will be blocked until it is detached.",
      aboutToRemoveFallback: "You are about to remove this skill.",
      currentlyUsedByPrefix: "Currently used by",
      currentlyUsedBySuffix: ".",
      detachBeforeRemoving: "Detach this skill from all agents to enable removal.",
      close: "Close",
      cancel: "Cancel",
      addSourceTitle: "Add a skill source",
      addSourceDescription: "Paste a local path, GitHub URL, or `skills.sh` command into the field first.",
      browseSkillsSh: "Browse skills.sh",
      browseSkillsShDescription: "Find install commands and paste one here.",
      searchGithub: "Search GitHub",
      searchGithubDescription: "Look for repositories with `SKILL.md`, then paste the repo URL here.",
    },
    status: {
      scanningProjects: "Scanning project workspaces for skills...",
      refreshingList: "Refreshing skills list...",
    },
    toasts: {
      importedTitle: "Skills imported",
      importWarningsTitle: "Import warnings",
      importFailedTitle: "Skill import failed",
      importFailedBody: "Failed to import skill source.",
      createdTitle: "Skill created",
      creationFailedTitle: "Skill creation failed",
      creationFailedBody: "Failed to create skill.",
      scanCompleteTitle: "Project skill scan complete",
      conflictsTitle: "Skill conflicts found",
      scanWarningsTitle: "Scan warnings",
      scanFailedTitle: "Project skill scan failed",
      scanFailedBody: "Failed to scan project workspaces.",
      savedTitle: "Skill saved",
      saveFailedTitle: "Save failed",
      saveFailedBody: "Failed to save skill file.",
      updatedTitle: "Skill updated",
      updateFailedTitle: "Update failed",
      updateFailedBody: "Failed to install skill update.",
      removedTitle: "Skill removed",
      removeFailedTitle: "Remove failed",
      removeFailedBody: "Failed to remove skill.",
    },
  },
  "zh-CN": {
    breadcrumbs: {
      skills: "技能",
      detail: "详情",
    },
    empty: {
      noCompanySelected: "选择一个公司以管理技能。",
      selectFile: "选择一个文件以查看内容。",
    },
    sources: {
      skillsShFallback: "skills.sh",
      skillsShManaged: "skills.sh 托管",
      githubFallback: "GitHub",
      githubManaged: "GitHub 托管",
      urlFallback: "URL",
      urlManaged: "URL 托管",
      folderFallback: "文件夹",
      folderManaged: "文件夹托管",
      paperclipFallback: "Paperclip",
      paperclipManaged: "Paperclip 托管",
      catalogFallback: "目录",
      catalogManaged: "目录托管",
    },
    newSkill: {
      namePlaceholder: "技能名称",
      slugPlaceholder: "可选短标识",
      descriptionPlaceholder: "简短描述",
      cancel: "取消",
      create: "创建技能",
      creating: "创建中...",
    },
    list: {
      title: "技能",
      detail: "详情",
      available: "个可用技能",
      scanWorkspace: "扫描项目工作区中的技能",
      filter: "筛选技能",
      sourcePlaceholder: "粘贴路径、GitHub URL 或 skills.sh 命令",
      add: "添加",
      noMatches: "没有技能匹配当前筛选。",
      expand: "展开",
      collapse: "收起",
    },
    pane: {
      selectSkill: "选择一个技能以查看文件。",
      remove: "移除",
      removeSkill: "移除技能",
      removing: "移除中...",
      edit: "编辑",
      stopEditing: "停止编辑",
      source: "来源",
      pin: "固定版本",
      tracking: "跟踪",
      key: "键",
      mode: "模式",
      editable: "可编辑",
      readOnly: "只读",
      usedBy: "已绑定到",
      noAgentsAttached: "尚未绑定任何智能体",
      checkForUpdates: "检查更新",
      installUpdate: "安装更新",
      upToDate: "已是最新",
      untracked: "未跟踪",
      view: "查看",
      code: "代码",
      save: "保存",
      saving: "保存中...",
      cancel: "取消",
      copiedPath: "已复制工作区路径",
      removeBlocked: "请先将此技能从所有智能体中解绑，再执行移除。",
    },
    dialogs: {
      removeTitle: "移除技能",
      removeDescription: "从公司技能库中移除此技能。如果仍有智能体在使用它，必须先解绑后才能移除。",
      aboutToRemoveFallback: "你即将移除此技能。",
      currentlyUsedByPrefix: "当前正在被以下智能体使用：",
      currentlyUsedBySuffix: "。",
      detachBeforeRemoving: "请先将此技能从所有智能体中解绑后再移除。",
      close: "关闭",
      cancel: "取消",
      addSourceTitle: "添加技能来源",
      addSourceDescription: "请先在输入框中粘贴本地路径、GitHub URL 或 `skills.sh` 命令。",
      browseSkillsSh: "浏览 skills.sh",
      browseSkillsShDescription: "找到安装命令后粘贴到这里。",
      searchGithub: "搜索 GitHub",
      searchGithubDescription: "查找包含 `SKILL.md` 的仓库，然后将仓库 URL 粘贴到这里。",
    },
    status: {
      scanningProjects: "正在扫描项目工作区中的技能...",
      refreshingList: "正在刷新技能列表...",
    },
    toasts: {
      importedTitle: "技能已导入",
      importWarningsTitle: "导入警告",
      importFailedTitle: "导入技能失败",
      importFailedBody: "导入技能来源失败。",
      createdTitle: "技能已创建",
      creationFailedTitle: "创建技能失败",
      creationFailedBody: "创建技能失败。",
      scanCompleteTitle: "项目技能扫描完成",
      conflictsTitle: "发现技能冲突",
      scanWarningsTitle: "扫描警告",
      scanFailedTitle: "项目技能扫描失败",
      scanFailedBody: "扫描项目工作区失败。",
      savedTitle: "技能已保存",
      saveFailedTitle: "保存失败",
      saveFailedBody: "保存技能文件失败。",
      updatedTitle: "技能已更新",
      updateFailedTitle: "更新失败",
      updateFailedBody: "安装技能更新失败。",
      removedTitle: "技能已移除",
      removeFailedTitle: "移除失败",
      removeFailedBody: "移除技能失败。",
    },
  },
} as const;

function resolveLocale(locale: CompanySkillsCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getCompanySkillsCopy(locale: CompanySkillsCopyLocale) {
  return companySkillsCopy[resolveLocale(locale)];
}

export function formatCompanySkillsAvailableCount(count: number, locale: CompanySkillsCopyLocale) {
  if (locale === "zh-CN") {
    return `${count} 个可用技能`;
  }
  return `${count} available`;
}

export function formatImportedSkillsCount(count: number, locale: CompanySkillsCopyLocale) {
  if (locale === "zh-CN") {
    return `新增了 ${count} 个技能。`;
  }
  return `${count} skill${count === 1 ? "" : "s"} added.`;
}

export function formatProjectScanSummary(result: CompanySkillProjectScanResult, locale: CompanySkillsCopyLocale) {
  if (locale === "zh-CN") {
    const parts = [
      `发现 ${result.discovered} 个`,
      `导入 ${result.imported.length} 个`,
      `更新 ${result.updated.length} 个`,
    ];
    if (result.conflicts.length > 0) parts.push(`冲突 ${result.conflicts.length} 个`);
    if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个`);
    return `${parts.join("，")}，共扫描 ${result.scannedWorkspaces} 个工作区。`;
  }

  const parts = [
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedWorkspaces} workspace${result.scannedWorkspaces === 1 ? "" : "s"}.`;
}

export function formatSkillCreatedBody(name: string, locale: CompanySkillsCopyLocale) {
  return locale === "zh-CN"
    ? `${name} 已可在 Paperclip 工作区中编辑。`
    : `${name} is now editable in the Paperclip workspace.`;
}

export function formatSkillUpdatedBody(name: string, sourceRef: string | null | undefined, locale: CompanySkillsCopyLocale) {
  if (sourceRef) {
    const shortRef = sourceRef.slice(0, 7);
    return locale === "zh-CN" ? `已固定到 ${shortRef}` : `Pinned to ${shortRef}`;
  }
  return name;
}

export function formatSkillRemovedBody(name: string, locale: CompanySkillsCopyLocale) {
  return locale === "zh-CN"
    ? `${name} 已从公司技能库中移除。`
    : `${name} was removed from the company skill library.`;
}

export function formatSkillDeletePrompt(name: string, locale: CompanySkillsCopyLocale) {
  return locale === "zh-CN" ? `你即将移除 ${name}。` : `You are about to remove ${name}.`;
}

export function formatSkillUsedByAgents(agentNames: string[], locale: CompanySkillsCopyLocale) {
  if (locale === "zh-CN") {
    return `当前正在被以下智能体使用：${agentNames.join("、")}。`;
  }
  return `Currently used by ${agentNames.join(", ")}.`;
}
