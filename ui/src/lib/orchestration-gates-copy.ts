/**
 * Orchestration gates page copy (isolated from i18n.ts to avoid whole-app HMR on edits).
 * @see OrchestrationGates.tsx
 */
/** 编排闸门页：只读说明控制面「工程自动化」有哪些闸门，与技能/提示词注入无关。 */
export const orchestrationGatesPage = {
  title: "编排闸门",
  subtitle:
    "用产品语言说明：系统在「定时巡检、有人互动、花钱/暂停、卡住恢复、自动开单」这些环节里，什么时候会动、动完会怎样；并收录 **API 心跳调度器** 里同一轮会跑的服务端编排（过去单独归在心跳里、没写进本表的那些）。不含智能体技能包、长文提示词拼装——那些请看「运行清单」对照单次运行。",
  selectCompany: "请选择团队查看编排闸门。",
  footnote:
    "具体数值与优先级以你当前运行的版本为准；升级或自建实例后可能微调。本页是说明书，不是实时监控大屏。",
  notInScope:
    "不包含：技能怎么打包、说明文档怎么拼进对话、一次运行实际喂给模型多长上下文——请用「运行清单」对照某次运行。",
  relatedHeartbeatTasks: "心跳任务（多久巡检、开不开）",
  relatedInjection: "运行清单（单次运行里上下文怎么拼的）",
  columnComponent: "调度组件",
  columnUi: "所属",
  columnConfigurable: "可配置项",
  columnHardcoded: "调度规则",
  columnCodeRef: "代码位置（可选）",
  expandSchedulingRules: "展开",
  collapseSchedulingRules: "收起",
  uiNone: "无单独页面",
  jumpHeartbeatTasks: "心跳任务",
  jumpCosts: "成本与预算",
  jumpAgents: "智能体列表",
  jumpOrchestrationInjection: "运行清单",
  jumpIssues: "事务清单",
  jumpInstanceExperimental: "实例实验设置",
} as const;

export type OrchestrationGatesTableRow = {
  id: string;
  component: string;
  uiLinks: ReadonlyArray<{ to: string; labelKey: keyof Pick<
    typeof orchestrationGatesPage,
    "jumpHeartbeatTasks" | "jumpCosts" | "jumpAgents" | "jumpOrchestrationInjection" | "jumpIssues" | "jumpInstanceExperimental"
  > }>;
  configurable: string;
  hardcoded: string;
  codeRef: string;
};

export const orchestrationGatesRows: ReadonlyArray<OrchestrationGatesTableRow> = [
  {
    id: "server-scheduler",
    component: "API 心跳调度",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "实例级：是否打开调度、整轮间隔多长（默认开、约每 30s 一轮，最短约 10s）；改部署后要重启。与「智能体心跳任务」页里每人自己的间隔是两层：这里管服务器多久跑一整轮，那里管某个经办多久巡检一次。具体变量名见代码位置。",
    hardcoded:
      "调度说明：服务端按固定周期拉起整链恢复，并决定每轮间隔。\n\n调度开启时：API 启动后先跑一轮，之后每到间隔再跑；每轮按序做**关单后运行结案**、孤儿回收、队列续跑、滞留对账、关系图、无输出、**产出纠偏**等，并与同一节拍上的定时唤醒、例行唤醒并行。定时 tick 内也会先扫一轮「事务已关单却仍显示进行中」的跑次。\n\n调度关闭时：整链不再触发。\n\n触发：进程已起、调度为开，且每到一轮间隔。\n\n结果：各子项含义与顺序见本表后文；整链与两类唤醒在同一间隔内跑完。",
    codeRef: "server/index.ts · config HEARTBEAT_SCHEDULER_ENABLED · HEARTBEAT_SCHEDULER_INTERVAL_MS",
  },
  {
    id: "timer",
    component: "心跳避退",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "心跳任务页：每个智能体「隔多久巡检一次」「要不要开」。若由运维部署：可改「礼让之后推迟多久再测下一次」（默认约 2 分钟），用来让评论/指派触发的跑次先跑完。",
    hardcoded:
      "避退说明：定时巡检与互动唤醒错峰。\n\n发生避让时：同一智能体若已有留言、指派等来源的跑次在排队或运行，定时这一轮不插队：不多开一轮纯定时跑，界面「上次心跳」会后移；运行清单可核对是否记录跳过。\n\n无事可领时：没有可领用的当事事务时，定时巡检也不会空转多排队。\n\n触发：到达心跳任务节奏；且要么没有可巡检领用的事务，要么仍有其他来源跑次未结束。\n\n结果：通常不新增一轮纯定时跑次，或把下次定时后推，并尽量留下可追溯说明。",
    codeRef: "orchestration-invariants · heartbeat-timer-yield · heartbeat",
  },
  {
    id: "heartbeat-tick-timers",
    component: "定时到点",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "节拍由「API 心跳调度」统一牵引；单次具体行为在智能体/事务策略里。不在本页改数值。",
    hardcoded:
      "定时到点说明：登记过的定时器一到点，就把对应唤醒排进执行队列。\n\n与「例行计划到点」同节拍：同一套心跳节拍里，先处理到期定时器，再接例行计划触发，然后进入整段服务器恢复链。\n\n触发：每到一轮调度间隔，且定时器队列里有到期项。\n\n结果：到期唤醒进入执行队列（仍过预算、暂停等闸门）。",
    codeRef: "server/index.ts setInterval · heartbeat.tickTimers · routines.tickScheduledTriggers",
  },
  {
    id: "routine-tick-scheduled",
    component: "例行计划到点",
    uiLinks: [{ to: "/issues", labelKey: "jumpIssues" }],
    configurable: "具体触发条件在例行/自动化配置里（若版本已露出）；时钟仍依赖实例级调度开关与间隔。",
    hardcoded:
      "例行计划到点说明：例行里配置的周期/定时到了，就按例行规则入队。\n\n与「定时到点」同节拍，但走例行事务管线，不走心跳里那条业务恢复子链。\n\n触发：每到一轮调度间隔，且例行侧有待触发项。\n\n结果：按例行定义排队运行或产生唤醒（细节以实现为准）。",
    codeRef: "routineService.tickScheduledTriggers · server/index.ts",
  },
  {
    id: "closed-issue-run-finalize",
    component: "关单后运行结案",
    uiLinks: [
      { to: "/runs", labelKey: "jumpOrchestrationInjection" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "无单独看板开关；跟随「API 心跳调度」每轮扫描。单智能体并行上限常为 1，有利于「一单一线程、关单后 CLI 自己退」。",
    hardcoded:
      "关单后运行结案说明：事务已标「已完成」或「已取消」，但某次运行仍显示「进行中」时，把控制面状态和事务锁对齐。\n\n主路径：经办在跑次里 PATCH 关单后，适配器应自己退出；控制面一直等到那次运行自然结束，并标「已完成」。本行是兜底，不抢在 CLI 还活着时乱杀进程。\n\n已完成：若这次运行已不在执行、登记进程也已退出，则把运行标为「已完成」（不是「为对账已取消」），释放执行锁，并记下结案说明。\n\n已取消：仍按「取消运行」收尾（用户意图是停）。\n\n仍跳过：同一跑次还在 executeRun 里等适配器返回；或本地 CLI 子进程仍存活（等你优雅退出）。\n\n触发：每个调度间隔（含启动首轮）；定时 tick 开头也会扫一轮。\n\n结果：看板不再长期挂着「事务已完、运行仍进行中」；不会因此误走滞留回收子单。",
    codeRef:
      "heartbeat.reconcileRunningRunsForClosedIssues · orchestration-invariants RUN_FINALIZE_ISSUE_CLOSED_DONE",
  },
  {
    id: "orphan-reap",
    component: "孤儿运行回收",
    uiLinks: [{ to: "/runs", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "周期性扫描可带「多久算陈旧」阈值（默认约 5 分钟，以当前实现为准）；属服务端内部策略，看板无单独页。",
    hardcoded:
      "孤儿运行回收说明：进程已经不在或状态和真实不一致时，把仍标成进行中的跑次收干净。\n\n不会动「事务已是已完成/已取消」的那张单：这类先交给上行「关单后运行结案」，避免误标失败、误触发滞留回收链。\n\n调度开着时：启动先收一轮，之后每个间隔再收（在关单结案之后）。默认带约 5 分钟陈旧阈值，减少刚关单、CLI 尚在收尾时的误判。\n\n触发：API 启动后首轮及之后每个调度间隔。\n\n结果：终止或修正孤儿跑次；可用环境变量关闭整段扫描。",
    codeRef: "heartbeat.reapOrphanedRuns · PAPERCLIP_ORPHAN_RUN_REAP_ENABLED",
  },
  {
    id: "promote-scheduled-retries",
    component: "重试提升",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "单次运行上的「计划重试」时刻多在运行/事务相关界面或记录里；全实例批量扫描节奏与「API 心跳调度」间隔一致。",
    hardcoded:
      "提升说明：到了预约重试点、仍处于「计划重试」状态的跑次，按轮从库里捞出并升阶；每轮条数上限以实现为准。\n\n触发：每个调度间隔内，在关单结案与孤儿回收之前、队列续跑之前。\n\n结果：到期重试进入可推进状态，与「预约重试」里「到点再跑」的约定衔接。",
    codeRef: "heartbeat.promoteDueScheduledRetries",
  },
  {
    id: "resume-queued-runs",
    component: "队列续跑",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "仍显示为「排队」的跑次表示已持久化落库；无单独总开关，跟随「API 心跳调度」轮询。",
    hardcoded:
      "续跑说明：仍处在排队里的跑次会先按智能体归并，再逐个尝试「启动该智能体的下一条排队跑次」；用在进程重启或切换之后，把上一进程留在库里的排队接着往前推。\n\n触发：每个调度间隔内，紧跟重试提升之后、关单结案与孤儿回收等之前；若提升步骤抛错，本轮续跑不会执行。\n\n结果：各智能体名下排队跑次有机会被拉起（仍过预算、暂停等闸门）。",
    codeRef: "heartbeat.resumeQueuedRuns · startNextQueuedRunForAgent",
  },
  {
    id: "stranded-wake-requeue",
    component: "滞留补救",
    uiLinks: [{ to: "/runs", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "团队、事务上的档位与预算仍适用。实例可单独关掉「自动建滞留回收子单」（通常只影响是否生成子单，不等同于整段滞留对账都停）；具体变量名见代码位置。本行的补派、唤醒多数仍会跑，除非协作树上有暂停类抑制。",
    hardcoded:
      "滞留补救说明：事务已分给经办，但当下没有健康执行路径时：先补唤醒、补派（含初次派活或续跑），不先走「滞留回收」子单。\n\n对账会在一批仍分给经办、事务尚在待办或进行中、且当下看不到排队或运行中路径等情况里找机会；需要时入滞留补救或初次派活队列。多轮仍拉不通，才会升高到阻塞并可能生成子单。\n\n触发：每轮调度里，重试提升与队列续跑之后。\n\n结果：经办多一次（或策略允许多次）自动唤醒；仍失败就看下行「滞留回收」。",
    codeRef: "recovery/reconcileStrandedAssignedIssues · enqueueStrandedIssueRecovery · enqueueInitialAssignedTodoDispatch · PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED",
  },
  {
    id: "issue-graph-liveness-reconcile",
    component: "关系图活性对账",
    uiLinks: [{ to: "/instance/settings/experimental", labelKey: "jumpInstanceExperimental" }],
    configurable:
      "实例设置 · 实验：是否启用自动恢复、回溯小时数（默认约一天，以页面为准）。",
    hardcoded:
      "关系图活性对账说明：依赖/阻塞关系长期不健康时，按实验设定自动恢复或开单。\n\n与滞留对账不同：盯的是图结构和升级类异常，不是「单条分派跑不通」。可与滞留链在同一轮里先后执行。\n\n触发：每轮调度（含启动首轮）且实验打开、回溯窗口内有命中项。\n\n结果：可能新建升级类事务并叫醒负责人，或沿用已有升级单。",
    codeRef: "heartbeat.reconcileIssueGraphLiveness · recovery/issue-graph-liveness",
  },
  {
    id: "silent-active-run-watchdog",
    component: "活跃无输出盯梢",
    uiLinks: [{ to: "/runs", labelKey: "jumpOrchestrationInjection" }],
    configurable: "阈值（约 1h / 4h 等）写在实现里，本页不暴露滑块；若将来实例级可配会出现在设置。",
    hardcoded:
      "活跃无输出盯梢说明：跑次长时间卡在活跃却几乎没控制台输出时，分级怀疑，并可能开复查单或留评论。\n\n与「心跳避退」不是一回事：这里盯的是输出静默，并对同类提醒去重。\n\n触发：每轮调度内，扫描正在跑且命中静默规则的心跳跑次。\n\n结果：可能创建或挂上「活跃无输出复核」类事务并叫醒；细节见活动日志。",
    codeRef: "recovery/scanSilentActiveRuns · heartbeat",
  },
  {
    id: "bare-wake",
    component: "无单不叫",
    uiLinks: [{ to: "/runs", labelKey: "jumpOrchestrationInjection" }],
    configurable: "没有单独总开关；一次叫醒必须能落到具体事务上，否则系统不认。",
    hardcoded:
      "无单不叫说明：说不清是哪张单就不叫醒；台账和界面要一致。\n\n拒绝「只有一句话、但绑不上任何事务」的即时叫醒，以免智能体在真空中瞎跑。事务已关单却仍挂着「进行中」的运行，请看本表「关单后运行结案」，不在此条里取消。\n\n触发：外部只丢了说明却指不到某条事务。\n\n结果：不进入执行队列，并留下可追溯的跳过原因。",
    codeRef: "orchestration-invariants HEARTBEAT_SKIP_ON_DEMAND_BARE_WAKE · heartbeat",
  },
  {
    id: "event-wake",
    component: "互动叫醒",
    uiLinks: [
      { to: "/issues", labelKey: "jumpIssues" },
      { to: "/runs", labelKey: "jumpOrchestrationInjection" },
    ],
    configurable:
      "可按事务调「评论叫醒要带多少上下文」（档位）；未设则用团队默认值。若当前界面没有该字段，只能走接口或等后续版本露出。",
    hardcoded:
      "互动叫醒说明：你在事务上一动，就叫醒经办人（同类会合并）。\n\n同一次保存里，对同一经办、同一张单的多重叫醒会合成一次，避免连续刷屏跑。评论特别长或点名很多时，会按档位做压缩再叫醒，减轻噪声和费用。\n\n触发：留言、改指派、签出、推进执行阶段等你日常在事务里做的操作。\n\n结果：一般只触发一轮叫醒，经办智能体可能带着压过的评论摘要继续干活。",
    codeRef: "routes/issues · comment-wake-tier",
  },
  {
    id: "budget",
    component: "预算暂停",
    uiLinks: [
      { to: "/costs", labelKey: "jumpCosts" },
      { to: "/agents", labelKey: "jumpAgents" },
    ],
    configurable: "成本页里公司 / 智能体 / 事务相关的额度与周期；智能体列表里可暂停某个智能体。",
    hardcoded:
      "预算暂停说明：钱不够或点了暂停，就先别跑（含个别智能体暂停）。\n\n系统按既定顺序检查「是否超支、是否暂停」等门槛，再决定能不能跑。\n\n触发：每一次「新的一次运行要排队」或「接着跑」之前。\n\n结果：直接拦住，并标明预算不足或已暂停等原因；运行记录里能看到对应说法。",
    codeRef: "budgets · heartbeat",
  },
  {
    id: "recovery",
    component: "协作树护栏",
    uiLinks: [{ to: "/runs", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "若实例对人因暂停、未复机等有抑制策略，以活动日志与当前版本为准。",
    hardcoded:
      "协作树护栏说明：协作树上有暂停类抑制时，别在不该自动救济时把阻塞链越拖越长。\n\n任何自动恢复进来前，都会先看树上是否挂着人因暂停、未复机一类抑制（与滞留、关系图等子项配套）。不等同于「关系图不健康」那一行。\n\n触发：要带自动救济的后台路径碰到该事务或其子树之前。\n\n结果：可能不再自动追加叫醒、阻塞边或回收子单，避免同一问题叠好几层。",
    codeRef: "recovery/pause-hold-guard · isAutomaticRecoverySuppressedByPauseHold",
  },
  {
    id: "stranded-recovery",
    component: "滞留回收",
    uiLinks: [
      { to: "/issues", labelKey: "jumpIssues" },
      { to: "/runs", labelKey: "jumpOrchestrationInjection" },
    ],
    configurable:
      "与「滞留补救」同一套：树上的暂停、预算、以及「是否自动建滞留回收子单」的实例开关都还在；最后一项往往只关建子单，不一定整段对账都停。变量名见代码位置。",
    hardcoded:
      "滞留回收说明：源单已分给经办却长期跑不通时，伸一张子单给管理人收场。\n\n同一源单通常只留一张进行中的滞留回收子单；已是回收子单的不再套娃。管理人在候选链里挑。跑完仍缺下一步时，也可能再走同类收尾单（标题里常会写出缺哪一步）。\n\n触发：滞留补救几轮仍拉不通、握手或续跑用尽等分支命中时；与同轮入队阶段相邻。\n\n结果：新建子事务指派给管理人并叫醒；源单可标成阻塞。本步之前的自动叫醒见上行「滞留补救」。",
    codeRef: "recovery/service · reconcileStrandedAssignedIssues · ensureStrandedIssueRecoveryIssue · PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED",
  },
  {
    id: "productivity",
    component: "产出纠偏",
    uiLinks: [],
    configurable:
      "无单独设置页；默认门槛写在服务端（如：无评论连击次数、活跃过久小时数、高波动窗口内跑次/评论数、24h 内最多自动新开几张复查单等）。升级或自建实例后数值可能微调。",
    hardcoded:
      "产出纠偏说明：系统觉得「产出或节奏不对劲」时，自动开一张审查类子事务给你拍板（单子 originKind 与滞留回收不同；不会在后台默默改掉业务结论）。\n\n主要几种命中模式（产品话，对应实现里的触发）：\n· 连着多轮跑完，经办却始终没有在事务上留下跑关联的评论（无评论连击 streak；默认约 10 次一档量级）。\n· 当前活跃执行段拖太久（默认约 6 小时这一档量级，以版本常量为准）。\n· 短时间内心跳跑次或经办相关评论过于频繁（实现里按 1 小时 / 6 小时窗口看 churn）。\n\n节制：默认 24 小时滚动窗口内，同类自动新建复查单有次数上限（避免雪崩；命中会表现为暂不再新建）。已在开的单子会按策略刷新证据评论，不等同于无限新建。\n\n触发：启动首轮与之后每个调度间隔里，紧跟「关系图活性」「活跃无输出盯梢」之后跑（整链顺序见上行「API 心跳调度」）。\n\n结果：新开或更新审查事务，描述里会带证据摘要（首句常为英文固定提示）；经办侧可能被叫醒；由人类决定是否改单、关单或改策略——系统不替你定业务结论。",
    codeRef: "heartbeat.reconcileProductivityReviews · productivity-review",
  },
  {
    id: "monitor",
    component: "执行盯梢",
    uiLinks: [{ to: "/issues", labelKey: "jumpIssues" }],
    configurable: "在事务侧维护「下一次何时再检查」（若详情或策略界面、接口有暴露）。若策略允许 **到期新建可见恢复单**，在同一事务或活动日志里能看到对应记录。",
    hardcoded:
      "执行盯梢说明：到点再查一眼（执行监控）。\n\n系统自动维护节奏，并让同类自动动作可区分、不重复刷同一件事。监控耗尽、超时等且策略为「建恢复单」时，会新开一张供人收场的事务（与「滞留回收」成因不同：这里偏执行阶段约定）。\n\n触发：到了你（或策略）定的「下一次检查」时刻，或你在界面里点「马上再查」（若有）。\n\n结果：叫醒经办按约定往下跑；或按策略结束监控。若配置为新建恢复单，你会多一张待处理事务（可在活动里搜监控恢复相关动作）。",
    codeRef: "issue-execution-policy · heartbeat",
  },
  {
    id: "retry",
    component: "预约重试",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "某次运行上可以约定「几点再试」「为什么再试」；部分界面在事务里能看或改「计划重试」（视版本）。",
    hardcoded:
      "预约重试说明：约好的重试时间到了，或系统发现该补一手。\n\n后台按固定节奏扫到期的重试；失败原因有一套固定说法。服务端批量先做「重试提升」再做「队列续跑」（见上文两行），与此处用户可见的预约互为补充。\n\n触发：到了预约时间；或需要补偿的情况（例如该落的评论没落下、进程异常退出等）。\n\n结果：重新排队再跑一轮；仍然要先过预算和暂停两关。",
    codeRef: "heartbeat",
  },
];
