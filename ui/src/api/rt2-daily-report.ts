import type {
  ListRt2DailyBoard,
  QueryRt2DailyWiki,
  Rt2DailyBoard,
  Rt2DailyReportCard,
  Rt2DailyWikiAnswer,
  Rt2DailyWikiPage,
  UpdateRt2DailyCardOkr,
  UpdateRt2DailyCardQuality,
  UpdateRt2DailyCardTitle,
  UpsertRt2DailyReportCard,
  UpsertRt2DailyCardDeliverable,
} from "@paperclipai/shared";
import { api } from "./client";

export type Rt2DailyReportSaveResponse = {
  card: Rt2DailyReportCard;
  wikiPage: Rt2DailyWikiPage;
};

export type Rt2DailyCardUpdateResponse = {
  card: Rt2DailyReportCard;
};

function buildDailyQueryParams(input: ListRt2DailyBoard) {
  const params = new URLSearchParams();
  params.set("projectId", input.projectId);
  params.set("reportDate", input.reportDate);
  return params.toString();
}

export const rt2DailyReportApi = {
  getBoard: (companyId: string, projectId: string, reportDate: string) => {
    const qs = buildDailyQueryParams({ projectId, reportDate });
    return api.get<Rt2DailyBoard>(`/companies/${encodeURIComponent(companyId)}/rt2/daily-report?${qs}`);
  },
  saveCard: (companyId: string, todoIssueId: string, data: UpsertRt2DailyReportCard) =>
    api.put<Rt2DailyReportSaveResponse>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}`,
      data,
    ),
  updateCardTitle: (companyId: string, todoIssueId: string, data: UpdateRt2DailyCardTitle & ListRt2DailyBoard) =>
    api.patch<Rt2DailyCardUpdateResponse>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}/title`,
      data,
    ),
  upsertCardDeliverable: (companyId: string, todoIssueId: string, data: UpsertRt2DailyCardDeliverable & ListRt2DailyBoard) =>
    api.put<Rt2DailyCardUpdateResponse>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}/deliverable`,
      data,
    ),
  updateCardQuality: (companyId: string, todoIssueId: string, data: UpdateRt2DailyCardQuality & ListRt2DailyBoard) =>
    api.patch<Rt2DailyCardUpdateResponse>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}/quality`,
      data,
    ),
  updateCardOkr: (companyId: string, todoIssueId: string, data: UpdateRt2DailyCardOkr & ListRt2DailyBoard) =>
    api.patch<Rt2DailyCardUpdateResponse>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-report/cards/${encodeURIComponent(todoIssueId)}/okr`,
      data,
    ),
  getWiki: (companyId: string, projectId: string, reportDate: string) => {
    const qs = buildDailyQueryParams({ projectId, reportDate });
    return api.get<Rt2DailyWikiPage>(`/companies/${encodeURIComponent(companyId)}/rt2/daily-wiki?${qs}`);
  },
  queryWiki: (companyId: string, data: QueryRt2DailyWiki & { projectId: string; reportDate: string }) =>
    api.post<Rt2DailyWikiAnswer>(
      `/companies/${encodeURIComponent(companyId)}/rt2/daily-wiki/query`,
      data,
    ),
};
