import type {
  AlertmanagerAlert,
  IssueRoute,
  IssueRouteMap,
} from "./types.js";

export interface IssueRouteResolution {
  route: IssueRoute | null;
  source:
    | {
        labelKey: string;
        labelValue: string;
      }
    | null;
}

export function resolveIssueRoute(
  alert: AlertmanagerAlert,
  issueRouteMap: IssueRouteMap | undefined,
): IssueRouteResolution {
  for (const labelKey of Object.keys(issueRouteMap ?? {})) {
    const labelValue = alert.labels[labelKey];
    if (!labelValue) continue;
    const route = issueRouteMap?.[labelKey]?.[labelValue];
    if (!route) continue;
    return {
      route,
      source: {
        labelKey,
        labelValue,
      },
    };
  }

  return { route: null, source: null };
}

