#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ZH_PATH = "ui/src/i18n/locales/zh-CN.json";

// Translation map: dotted key → Chinese translation
// Preserves {{interpolation}} placeholders, HTML entities, and brand names.
const translations = {
  // agents
  "agents.text.runHeartbeat": "运行心跳",
  "agents.aria.invalidReportingChain": "汇报链无效",

  // secrets
  "secrets.errors.unexpectedError": "意外错误",
  "secrets.errors.selectAProvider": "请选择提供商。",
  "secrets.errors.thisProviderVaultIsDisabled": "此提供商保险库已禁用。",
  "secrets.errors.thisProviderVaultIsSavedAsDraftMetadataOnly": "此提供商保险库仅保存为草稿元数据。",
  "secrets.errors.deploymentDefault": "部署默认值",
  "secrets.placeholders.autoFromName": "从名称自动生成",
  "secrets.text.selectACompanyToManageSecrets": "选择一家公司来管理密钥。",
  "secrets.text.newSecret": "新建密钥",
  "secrets.text.failedToLoadSecrets": "加载密钥失败:",
  "secrets.text.lastRotated": "上次轮换",
  "secrets.text.lastResolved": "上次解析",
  "secrets.text.open": "打开",
  "secrets.text.delete": "删除",
  "secrets.text.secretReferences": "密钥引用",
  "secrets.text.createSecret": "创建密钥",
  "secrets.text.chooseWhetherPaperclipShouldOwnFutureProviderWrite": "选择 Paperclip 是否应拥有未来的提供商写入权限,或仅在运行时解析现有的提供商引用。",
  "secrets.text.managedValue": "托管值",
  "secrets.text.externalReference": "外部引用",
  "secrets.text.providerVault": "提供商保险库",
  "secrets.text.deploymentDefault": "部署默认",
  "secrets.text.existingDeploymentLevelProviderSettingsStayAvailab": "现有的部署级提供商设置仍可用于向后兼容。",
  "secrets.text.paperclipManagedSecretsAreCreatedInTheSelectedProv": "Paperclip 托管的密钥在选定的提供商中创建,未来的轮换通过 Paperclip 写入新的提供商版本。",
  "secrets.text.existingProviderSecretsAreResolveOnlyInPaperclipRo": "现有的提供商密钥在 Paperclip 中仅为只读解析。请在提供商中轮换值,然后仅当路径、ARN 或版本更改时才更新此引用。",
  "secrets.text.cancel": "取消",
  "secrets.text.saveOnlyNonSensitiveRoutingMetadataCredentialsStay": "仅保存非敏感路由元数据。凭据保留在运行时环境或提供商身份中。",
  "secrets.text.displayName": "显示名称",
  "secrets.text.warning": "警告",
  "secrets.text.comingSoon": "即将推出",
  "secrets.text.defaultFor": "默认用于",
  "secrets.text.thisProviderCanSaveDraftRoutingMetadataButRuntimeW": "此提供商可以保存草稿路由元数据,但在提供商模块实现并审核之前,运行时写入和解析保持禁用。",
  "secrets.text.rotatingWithTheDeploymentDefaultPreservesCurrentFa": "使用部署默认值轮换可保留当前回退行为。",
  "secrets.text.rotateTheActualValueInTheProviderBeforeChangingThi": "在更改此 Paperclip 引用之前,请先轮换提供商中的实际值。",
  "secrets.text.newValue": "新值",
  "secrets.text.deleteSecret": "删除密钥",
  "secrets.text.permanentlyRemoves": "永久移除",
  "secrets.text.activeBindingsWillFailUntilYouRemapThem": "。活跃绑定将失败,直到您重新映射它们。",
  "secrets.text.removeProviderVault": "移除提供商保险库",
  "secrets.text.fromPaperclipOnly": "仅从 Paperclip 中移除。",
  "secrets.text.secretsUsingThisVaultWillLoseTheVaultAssociationUn": "使用此保险库的密钥将失去保险库关联,直到您分配另一个。",
  "secrets.text.removeFromPaperclip": "从 Paperclip 移除",
  "secrets.text.useSecretsByBindingThemToRuntimeEnvironmentVariabl": "通过将密钥绑定到运行时环境变量来使用它们。",
  "secrets.text.createOrLinkASecretHereThenOpenAnAgentAposSEnviron": "在此创建或链接密钥,然后打开智能体的环境变量或项目的环境字段。添加进程期望的环境键,例如",
  "secrets.text.andSelectTheStoredSecretVersion": ",并选择存储的密钥版本。",
  "secrets.text.paperclipResolvesTheValueServerSideWhenTheRunStart": "Paperclip 在运行启动时在服务端解析值,并将其注入为该环境变量。项目环境应用于项目中的每个任务,并在匹配键上覆盖智能体环境。",
  "secrets.text.allProviders": "所有提供商",
  "secrets.text.importFromVault": "从保险库导入",
  "secrets.text.loadingProviderVaults": "加载提供商保险库",
  "secrets.text.failedToLoadProviderVaults": "加载提供商保险库失败:",
  "secrets.text.addVault": "添加保险库",
  "secrets.text.healthNotChecked": "未检查健康状态",
  "secrets.text.checkHealth": "检查健康状态",
  "secrets.text.refreshSecrets": "刷新密钥",
  "secrets.text.makeDefault": "设为默认",
  "secrets.text.remove": "移除",
  "secrets.text.iUnderstandBackupAndRestoreRequireBothTheDatabaseM": "我了解备份和恢复需要数据库元数据和本地加密主密钥文件。",
  "secrets.text.usesTheCurrentDraftRoutingFieldsToInspectAwsSecret": "使用当前草稿路由字段检查 AWS Secrets Manager 元数据。不会读取值。",
  "secrets.text.findExistingAwsValues": "查找现有 AWS 值",
  "secrets.text.enterAnAwsRegionBeforeDiscovery": "请在发现之前输入 AWS 区域。",
  "secrets.text.searchingAwsSecretsManagerMetadata": "正在搜索 AWS Secrets Manager 元数据",
  "secrets.text.noAwsVaultMetadataCandidatesFoundManualEntryIsStil": "未找到 AWS 保险库元数据候选。仍可手动输入。",
  "secrets.text.vaultContext": "保险库上下文",
  "secrets.text.safeRequestErrorDetails": "安全请求/错误详情",
  "secrets.text.useValues": "使用值",
  "secrets.text.paperclipNeverReDisplaysStoredValues": "Paperclip 永远不会重新显示已存储的值。",
  "secrets.text.loading": "加载中…",
  "secrets.text.noActiveBindingsAddThisSecretInAgentProjectEnviron": "无活跃绑定。在智能体、项目、环境或插件配置中添加此密钥即可开始使用。",
  "secrets.text.noAccessEventsRecordedYetEachRuntimeResolutionWrit": "尚无访问事件记录。每次运行时解析都会在此写入一条脱敏记录。",
  "secrets.labelsJsx.configureAnAwsProviderVaultToEnableRemoteImport": "配置 AWS 提供商保险库以启用远程导入",

  // companyAccess
  "companyAccess.text.humans": "人类成员",
  "companyAccess.text.selectCompany": "选择一家公司",

  // issueDocumentsSection
  "issueDocumentsSection.text.revisionHistory": "修订历史",
  "issueDocumentsSection.text.currentRevision": "当前",
  "issueDocumentsSection.text.updated": "更新于",

  // issueFiltersPopover
  "issueFiltersPopover.text.assignee": "负责人",
  "issueFiltersPopover.text.creator": "创建者",
  "issueFiltersPopover.text.externalObjectStatus": "外部对象状态",
  "issueFiltersPopover.text.filters": "快速筛选",
  "issueFiltersPopover.text.hideRoutineRuns": "隐藏例程运行",
  "issueFiltersPopover.text.labels": "标签",
  "issueFiltersPopover.text.liveRunsOnly": "仅显示运行中",
  "issueFiltersPopover.text.noAssignee": "无负责人",
  "issueFiltersPopover.text.noCreatorsMatch": "无匹配的创建者",
  "issueFiltersPopover.text.priority": "优先级",
  "issueFiltersPopover.placeholders.searchCreators": "搜索创建者...",

  // envVarEditor
  "envVarEditor.errors.createSecret": "创建密钥失败",
  "envVarEditor.labelsJsx.bindingMode": "绑定模式",
  "envVarEditor.labelsJsx.secret": "密钥",
  "envVarEditor.labelsJsx.version": "版本",
  "envVarEditor.placeholders.selectSecret": "选择密钥",
  "envVarEditor.text.plain": "纯文本",
  "envVarEditor.text.secret": "密钥",

  // scheduleEditor
  "scheduleEditor.labelsJsx.cronExpression": "Cron 表达式",
  "scheduleEditor.labelsJsx.scheduleFrequency": "调度频率",
  "scheduleEditor.placeholders.chooseFrequency": "选择频率...",
  "scheduleEditor.status.custom": "自定义 (cron)",
  "scheduleEditor.status.everyDay": "每天",
  "scheduleEditor.status.everyHour": "每小时",
  "scheduleEditor.tabs.everyMinute": "每分钟",
  "scheduleEditor.tabs.monthly": "每月",
  "scheduleEditor.tabs.weekdays": "工作日",
  "scheduleEditor.tabs.weekly": "每周",

  // trustPresetSection
  "trustPresetSection.text.issue": "任务",
  "trustPresetSection.text.project": "项目",
  "trustPresetSection.text.trust": "信任预设",
  "trustPresetSection.labelsJsx.allowedAgents": "允许的智能体",
  "trustPresetSection.labelsJsx.allowedSecrets": "允许的密钥",
  "trustPresetSection.labelsJsx.allowedTools": "允许的工具",
  "trustPresetSection.labelsJsx.boundaryType": "边界类型",
  "trustPresetSection.labelsJsx.eeFields": "EE 字段",

  // agentBubbleActionRow
  "agentBubbleActionRow.text.alwaysAllow": "始终允许",
  "agentBubbleActionRow.text.alwaysSavedLocally": "始终本地保存",
  "agentBubbleActionRow.text.whatBetter": "有什么可以改进的?",
  "agentBubbleActionRow.labelsJsx.copyMessage": "复制消息",
  "agentBubbleActionRow.labelsJsx.helpful": "有帮助",
  "agentBubbleActionRow.labelsJsx.moreActions": "更多操作",
  "agentBubbleActionRow.labelsJsx.needsWork": "需要改进",
  "agentBubbleActionRow.placeholders.shortNote": "简短备注...",

  // priorityIcon
  "priorityIcon.tabs.critical": "紧急",
  "priorityIcon.tabs.high": "高",
  "priorityIcon.tabs.medium": "中",

  // misc
  "newGoalDialog.placeholders.goalTitle": "目标标题",
  "agentIconPicker.placeholders.searchIcons": "搜索图标...",

  // stagesecretspanel
  "stagesecretspanel.text.theseEnvVarsAreInjectedWhen": "以下环境变量将在",
  "stagesecretspanel.text.runsThisStepTheyOverrideMatchingProjectAndAgentEnv": "运行此步骤时注入。冲突时它们将覆盖匹配的项目和智能体环境变量。",
  "stagesecretspanel.text.namesAreReserved": "名称已保留。",
  "stagesecretspanel.text.loadingSecrets": "加载密钥中…",
  "stagesecretspanel.text.unsavedChanges": "未保存的更改",

  // importfromvaultdialog
  "importfromvaultdialog.text.failed": "失败",
  "importfromvaultdialog.text.importFromAwsSecretsManager": "从 AWS Secrets Manager 导入",
  "importfromvaultdialog.text.bringAwsManagedSecretsIntoPaperclipAsExternalRefer": "将 AWS 管理的密钥作为外部引用导入 Paperclip。",
  "importfromvaultdialog.text.cancel": "取消",
  "importfromvaultdialog.text.notVisibleWithCurrentSearch": "在当前搜索中不可见",
  "importfromvaultdialog.text.remoteName": "远程名称",
  "importfromvaultdialog.text.lastChanged": "上次更改",
  "importfromvaultdialog.text.suggestedName": "建议名称",
  "importfromvaultdialog.text.alreadyImported": "已导入",
  "importfromvaultdialog.text.loading": "加载中…",
  "importfromvaultdialog.text.paperclipName": "Paperclip 名称",
  "importfromvaultdialog.errors.unexpectedError": "意外错误",
  "importfromvaultdialog.errors.nameIsRequired": "名称为必填项。",
  "importfromvaultdialog.errors.nameMustBe160CharactersOrFewer": "名称不能超过 160 个字符。",
  "importfromvaultdialog.errors.keyIsRequired": "键为必填项。",
  "importfromvaultdialog.errors.keyMayOnlyContainLowercaseLettersNumbersDotUndersc": "键只能包含小写字母、数字、点、下划线或连字符。",
  "importfromvaultdialog.errors.keyMustBe120CharactersOrFewer": "键不能超过 120 个字符。",
  "importfromvaultdialog.errors.descriptionMustBe500CharactersOrFewer": "描述不能超过 500 个字符。",
  "importfromvaultdialog.errors.aPaperclipSecretAlreadyUsesThisName": "已有 Paperclip 密钥使用了此名称。",
  "importfromvaultdialog.errors.aPaperclipSecretAlreadyUsesThisKey": "已有 Paperclip 密钥使用了此键。",
  "importfromvaultdialog.errors.anotherRowInThisBatchAlreadyUsesThisName": "此批次中已有另一行使用了此名称。",
  "importfromvaultdialog.errors.anotherRowInThisBatchAlreadyUsesThisKey": "此批次中已有另一行使用了此键。",
  "importfromvaultdialog.labels.importFailed": "导入失败",
  "importfromvaultdialog.labels.couldNotLoadMoreResults": "无法加载更多结果",
  "importfromvaultdialog.aria.closeImportDialog": "关闭导入对话框",
  "importfromvaultdialog.aria.selectAwsVault": "选择 AWS 保险库",
  "importfromvaultdialog.aria.searchRemoteSecrets": "搜索远程密钥",
  "importfromvaultdialog.aria.refreshRemoteSecrets": "刷新远程密钥",
  "importfromvaultdialog.placeholders.selectAnAwsVault": "选择 AWS 保险库",
  "importfromvaultdialog.placeholders.searchByNameArnTag": "按名称、ARN、标签搜索",
  "importfromvaultdialog.labelsJsx.failed": "失败",

  // issuedetail
  "issuedetail.errors.onlyBoardUsersCanPreviewSubtreeControls": "仅 Board 用户可预览子树控制。",
  "issuedetail.errors.previewIsStaleBecauseSubtreeHoldStateChangedRetryT": "预览已过期,因为子树保持状态已更改。请重试以刷新。",
  "issuedetail.errors.thisSubtreeActionIsCurrentlyInvalidForTheSelectedT": "此子树操作对所选任务当前无效。",
  "issuedetail.text.noProject": "无项目",
  "issuedetail.text.copyAsMarkdown": "复制为 Markdown",
  "issuedetail.text.hideThisTask": "隐藏此任务",
  "issuedetail.text.costSummary": "费用汇总",
  "issuedetail.text.noCostDataYet": "暂无费用数据。",
  "issuedetail.text.thisTask": "此任务",
  "issuedetail.text.noDirectCostData": "无直接费用数据。",
  "issuedetail.text.includingSubTasks": "包含子任务",
  "issuedetail.text.uploadAttachment": "上传附件",
  "issuedetail.text.thisTaskIsHidden": "此任务已隐藏",
  "issuedetail.text.viewAffected": "查看受影响 (",
  "issuedetail.text.cancelSubtree": "取消子树...",
  "issuedetail.text.thisTaskIsPausedByAncestor": "此任务被上级暂停",
  "issuedetail.text.resumeFromTheRootTaskToDeliverDeferredWork": "。从根任务恢复以交付延迟的工作。",
  "issuedetail.text.productivityReview": "生产力审查",
  "issuedetail.text.blockedByParkedWork": "被搁置的工作阻塞",
  "issuedetail.text.pauseWork": "暂停工作...",
  "issuedetail.text.resumeWork": "恢复工作",
  "issuedetail.text.pauseSubtree": "暂停子树...",
  "issuedetail.text.resumeSubtree": "恢复子树",
  "issuedetail.text.restoreSubtree": "恢复子树...",
  "issuedetail.text.newSubTask": "新建子任务",
  "issuedetail.text.relatedWork": "相关工作",
  "issuedetail.text.cancellingASubtreeIsDestructiveNonTerminalTasksWil": "取消子树是破坏性操作。非终态任务将被标记为已取消,运行中或排队的工作将尽可能被中断。",
  "issuedetail.text.wakeAffectedAgents": "唤醒受影响的智能体 (",
  "issuedetail.text.iUnderstandThisWillCancel": "我了解这将取消",
  "issuedetail.text.retryPreview": "重试预览",
  "issuedetail.text.previewUnavailable": "预览不可用。",
  "issuedetail.text.close": "关闭",
  "issuedetail.toasts.theActiveRunIsStoppingSoQueuedCommentsCanContinueN": "活跃运行正在停止,排队的评论可以继续下一步。",
  "issuedetail.toasts.theQueuedMessageWasRestoredToTheComposer": "排队的消息已恢复到编辑器。",
  "issuedetail.toasts.theThreadNowShowsADeletedCommentMarker": "对话现在显示已删除评论标记。",
  "issuedetail.labels.theActiveRunIsStoppingSoQueuedCommentsCanContinueN": "活跃运行正在停止,排队的评论可以继续下一步。",
  "issuedetail.labels.theQueuedMessageWasRestoredToTheComposer": "排队的消息已恢复到编辑器。",
  "issuedetail.labels.theThreadNowShowsADeletedCommentMarker": "对话现在显示已删除评论标记。",
  "issuedetail.labelsJsx.thisTaskIsAProductivityReview": "此任务是生产力审查。",
  "issuedetail.labelsJsx.thisTaskIsAGeneratedWatchdogTaskItVerifiesWhetherS": "此任务是自动生成的看门狗任务。它验证被监视任务树中停止的工作是否合理。",
  "issuedetail.labelsJsx.blockedByParkedWorkAtLeastOneAssignedBlockerIsInBa": "被搁置工作阻塞 — 至少一个分配的阻塞项在待办列表中,不会唤醒其负责人。",
  "issuedetail.labelsJsx.copyTaskAsMarkdown": "复制任务为 Markdown",
  "issuedetail.labelsJsx.archiveFromInbox": "从收件箱归档",
  "issuedetail.labelsJsx.openFileGF": "打开文件... (g f)",
  "issuedetail.labelsJsx.showProperties": "显示属性",
  "issuedetail.labelsJsx.moreTaskActions": "更多任务操作",
  "issuedetail.placeholders.addADescription": "添加描述...",
  "issuedetail.placeholders.explainWhyThisSubtreeControlIsBeingApplied": "说明为什么应用此子树控制...",

  // issueproperties
  "issueproperties.errors.githubPullRequest": "GitHub Pull Request",
  "issueproperties.errors.githubIssue": "GitHub Issue",
  "issueproperties.errors.notScheduled": "未调度",
  "issueproperties.errors.pendingSchedule": "等待调度",
  "issueproperties.text.remove": "移除",
  "issueproperties.text.asABlockerForThisTask": "作为此任务的阻塞项。",
  "issueproperties.text.removeBlocker": "移除阻塞项",
  "issueproperties.text.usesTheAgentAposSConfiguredCheapProfile": "· 使用智能体配置的经济模型",
  "issueproperties.text.fallsBackToThePrimaryModelIfNoCheapProfileIsConfig": "· 如未配置经济模型则回退到主模型",
  "issueproperties.text.enableChromeChrome": "启用 Chrome (--chrome)",
  "issueproperties.text.clearAdapterOptions": "清除适配器选项",
  "issueproperties.text.watchdogTask": "看门狗任务:",
  "issueproperties.text.retryNow": "立即重试",
  "issueproperties.text.assignToMe": "分配给我",
  "issueproperties.text.noParent": "无父任务",
  "issueproperties.text.noBlockers": "无阻塞项",
  "issueproperties.text.addBlocker": "添加阻塞项",
  "issueproperties.text.addSubTask": "添加子任务",
  "issueproperties.text.viewWorkspace": "查看工作区",
  "issueproperties.placeholders.whatShouldTheWatchdogWatchForAndHowShouldItKeepWor": "看门狗应监视什么?如何保持工作推进?",
  "issueproperties.labelsJsx.addLabel": "添加标签",
  "issueproperties.labelsJsx.clearAdapterOptions": "清除适配器选项",
  "issueproperties.labelsJsx.openWatchdogTask": "打开看门狗任务",

  // issueslist
  "issueslist.text.noActiveSubTasks": "无活跃子任务",
  "issueslist.text.allSubTasksDone": "所有子任务已完成",
  "issueslist.text.noActionableSubTasks": "无可操作的子任务",
  "issueslist.text.showingUpTo": "最多显示",
  "issueslist.text.matchesRefineTheSearchToNarrowFurther": "个匹配项。优化搜索以进一步缩小范围。",
  "issueslist.text.someBoardColumnsAreShowingUpTo": "部分看板列最多显示",
  "issueslist.text.tasksRefineFiltersOrSearchToRevealTheRest": "个任务。优化筛选或搜索以显示其余。",
  "issueslist.text.needsNextStep": "需要下一步",
  "issueslist.text.noAssignee": "无负责人",
  "issueslist.labelsJsx.listView": "列表视图",
  "issueslist.labelsJsx.boardView": "看板视图",
  "issueslist.labelsJsx.cardsPerColumn": "每列卡片数",
  "issueslist.labelsJsx.resetBoardDensity": "重置看板密度",
  "issueslist.labelsJsx.chooseWhichTaskColumnsStayVisible": "选择哪些任务列保持可见",
  "issueslist.labelsJsx.thisTaskNeedsANextStep": "此任务需要下一步",
};

// Apply translations
const zh = JSON.parse(fs.readFileSync(ZH_PATH, "utf8"));
let applied = 0;
for (const [key, value] of Object.entries(translations)) {
  setKey(zh, key, value);
  applied++;
}

fs.writeFileSync(ZH_PATH, JSON.stringify(zh, null, 2) + "\n", "utf8");
console.log(`✓ Applied ${applied} Chinese translations to zh-CN.json`);

function setKey(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
