type ApprovalsCopyLocale = string | null | undefined;

const approvalsCopy = {
  en: {
    title: "Approvals",
    pending: "Pending",
    all: "All",
    selectCompany: "Select a company first.",
    failedApprove: "Failed to approve",
    failedReject: "Failed to reject",
    noPending: "No pending approvals.",
    noApprovals: "No approvals yet.",
    approve: "Approve",
    approving: "Approving...",
    reject: "Reject",
    rejecting: "Rejecting...",
    requestedBy: "Requested by",
    decisionNote: "Decision note.",
    viewDetails: "View details",
    requestCreatedPrefix: "Approval request created",
    statusPending: "Pending",
    statusApproved: "Approved",
    statusRejected: "Rejected",
    statusRevisionRequested: "Revision requested",
    typeHireAgent: "Hire Agent",
    typeCeoStrategy: "CEO Strategy",
    typeBudgetOverride: "Budget Override",
    typeBoardApproval: "Board Approval",
    name: "Name",
    role: "Role",
    titleField: "Title",
    icon: "Icon",
    capabilities: "Capabilities",
    adapter: "Adapter",
    skills: "Skills",
    scope: "Scope",
    window: "Window",
    metric: "Metric",
    limit: "Limit",
    observed: "Observed",
    summary: "Summary",
    recommendedAction: "Recommended action",
    onApproval: "On approval",
    risks: "Risks",
    proposedComment: "Proposed comment",
  },
  "zh-CN": {
    title: "审批",
    pending: "待处理",
    all: "全部",
    selectCompany: "请先选择公司。",
    failedApprove: "批准失败",
    failedReject: "拒绝失败",
    noPending: "暂无待处理审批。",
    noApprovals: "暂时还没有审批记录。",
    approve: "批准",
    approving: "批准中...",
    reject: "拒绝",
    rejecting: "拒绝中...",
    requestedBy: "请求方",
    decisionNote: "审批备注。",
    viewDetails: "查看详情",
    requestCreatedPrefix: "审批请求创建于",
    statusPending: "待处理",
    statusApproved: "已批准",
    statusRejected: "已拒绝",
    statusRevisionRequested: "需修订",
    typeHireAgent: "招聘智能体",
    typeCeoStrategy: "CEO 策略",
    typeBudgetOverride: "预算覆盖",
    typeBoardApproval: "董事会审批",
    name: "名称",
    role: "角色",
    titleField: "标题",
    icon: "图标",
    capabilities: "能力",
    adapter: "适配器",
    skills: "技能",
    scope: "范围",
    window: "窗口",
    metric: "指标",
    limit: "上限",
    observed: "已观测",
    summary: "摘要",
    recommendedAction: "建议操作",
    onApproval: "批准后动作",
    risks: "风险",
    proposedComment: "建议评论",
  },
} as const;

function resolveLocale(locale: ApprovalsCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getApprovalsCopy(locale: ApprovalsCopyLocale) {
  return approvalsCopy[resolveLocale(locale)];
}

export function formatApprovalRequestCreated(relativeTime: string, locale: ApprovalsCopyLocale) {
  const copy = getApprovalsCopy(locale);
  return `${copy.requestCreatedPrefix} ${relativeTime}`;
}

export function formatApprovalStatus(status: string, locale: ApprovalsCopyLocale) {
  const copy = getApprovalsCopy(locale);
  return (
    {
      pending: copy.statusPending,
      approved: copy.statusApproved,
      rejected: copy.statusRejected,
      revision_requested: copy.statusRevisionRequested,
    }[status] ?? status.replace(/_/g, " ")
  );
}

export function approvalTypeLabel(type: string, locale: ApprovalsCopyLocale) {
  const copy = getApprovalsCopy(locale);
  return (
    {
      hire_agent: copy.typeHireAgent,
      approve_ceo_strategy: copy.typeCeoStrategy,
      budget_override_required: copy.typeBudgetOverride,
      request_board_approval: copy.typeBoardApproval,
    }[type] ?? type
  );
}
