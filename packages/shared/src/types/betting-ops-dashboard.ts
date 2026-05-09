export type BettingOpsDashboardDistributionPoint = {
  label: string;
  value: number;
};

export type BettingOpsDashboardSeriesPoint = {
  label: string;
  timestamp: string;
  balance: number;
  pnl: number;
};

export type BettingOpsDashboardSeriesCollection = {
  daily: BettingOpsDashboardSeriesPoint[];
  weekly: BettingOpsDashboardSeriesPoint[];
  monthly: BettingOpsDashboardSeriesPoint[];
};

export type BettingOpsDashboardSlipLeg = {
  pick: string;
  matchLabel: string | null;
  confidencePercent: number | null;
};

export type BettingOpsDashboardSlip = {
  id: string;
  title?: string | null;
  source: string;
  taskIdentifier: string | null;
  createdAt: string;
  legs: BettingOpsDashboardSlipLeg[];
  totalOdds?: number | null;
  totalStake?: number | null;
  currency?: string | null;
  status: string | null;
  combinedProbabilityPercent?: number | null;
  combinedOdds?: number | null;
  note?: string | null;
};

export type BettingOpsDashboardEntry = {
  id: string;
  kind: "placed" | "recommended" | "simulated" | string;
  status: string;
  matchLabel: string;
  sport: string | null;
  league: string | null;
  startsAt: string | null;
  settledAt: string | null;
  pick: string | null;
  market: string | null;
  confidencePercent: number | null;
  edgePercent: number | null;
  odds: number | null;
  targetOdds: number | null;
  stake: number | null;
  bookmaker: string | null;
  source: string;
  agentName: string | null;
  taskIdentifier: string | null;
  reasoning: string | null;
  profitLoss: number | null;
  currency: string | null;
  createdAt: string;
};

export type BettingOpsDashboardMatch = {
  id: string;
  externalId: string | null;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: string;
  status: string;
  sourceCount: number;
  hasRecommendation: boolean;
  hasPlacedBet: boolean;
};

export type BettingOpsDashboardAgentMetric = {
  agentId: string;
  agentName: string;
  role: string | null;
  status: string;
  runs7d: number;
  failedRuns7d: number;
  openIssues: number;
  completedIssues30d: number;
  recommendations: number;
  placedBets: number;
};

export type BettingOpsDashboardDailyPerf = {
  date: string;
  openingBankroll: number;
  closingBankroll: number;
  profitLoss: number;
  betsCount: number;
};

export type BettingOpsDashboardSimBet = {
  betId: string;
  rank: number;
  betType: string;
  market: string;
  totalOdds: number;
  recommendedStake: number;
  sport: string | null;
  league: string | null;
  outcomeStatus: string;
  profitLoss: number;
};

export type BettingOpsDashboardSimulation = {
  id: string;
  sessionDate: string;
  generatedAt: string;
  wouldBeBets: number;
  totalRecommendedStake: number;
  projectedProfitLoss: number;
  projectedRoiPct: number;
  won: number;
  lost: number;
  bets: BettingOpsDashboardSimBet[];
};

export type BettingOpsDashboardShortcutInfo = {
  targetUrl: string;
  desktopPath: string;
  installed: boolean;
};

export type BettingOpsDashboardShortcutInstallResult = BettingOpsDashboardShortcutInfo & {
  installed: true;
};

export type BettingOpsDashboardData = {
  companyId: string;
  generatedAt: string;
  refreshIntervalMs: number;
  overview: {
    currentBankroll: number | null;
    initialBankroll: number | null;
    totalPnl: number | null;
    totalPnlPercent: number | null;
    todayPnl: number;
    todayPnlPercent: number | null;
    openRecommendations: number;
    activePlacedBets: number;
    upcomingMatches24h: number;
    winRatePercent: number | null;
    roiPercent: number | null;
  };
  bankrollSeries: BettingOpsDashboardSeriesCollection;
  trackedMatches: BettingOpsDashboardMatch[];
  entries: BettingOpsDashboardEntry[];
  slips: BettingOpsDashboardSlip[];
  sportDistribution: BettingOpsDashboardDistributionPoint[];
  leagueDistribution: BettingOpsDashboardDistributionPoint[];
  roiByBetType: BettingOpsDashboardDistributionPoint[];
  agentMetrics: BettingOpsDashboardAgentMetric[];
  shortcut: BettingOpsDashboardShortcutInfo;
  dailyPerformance: BettingOpsDashboardDailyPerf[];
  simulations: BettingOpsDashboardSimulation[];
};
