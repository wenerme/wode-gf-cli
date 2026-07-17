import type { PanelJsonObject } from "../../lib/panel-tree";
import { type ResourceSelector, ResourceSelectorSchema } from "../../schema";
import type { CommandAppContext } from "../runtime";

export type DashboardSelection = {
  wrapper: PanelJsonObject;
  dashboard: PanelJsonObject;
  uid: string;
  title: string;
};

function dashboardSelectors(token: string): ResourceSelector[] {
  const selectors: ResourceSelector[] = [];
  if (/^\d+$/.test(token)) {
    selectors.push(ResourceSelectorSchema.parse({ id: token, uid: token, where: [] }));
  } else {
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  }
  selectors.push(ResourceSelectorSchema.parse({ title: token, where: [] }));
  return selectors;
}

export function selectDashboardByToken(
  items: unknown[],
  token: string,
  selectResource: CommandAppContext["runtime"]["selectResource"],
): unknown | undefined {
  let lastNoMatch: Error | undefined;
  for (const selector of dashboardSelectors(token.trim())) {
    try {
      return selectResource(items, "dashboards", selector, false);
    } catch (error) {
      const err = error as Error;
      if (err.message === "No dashboards matched selector") {
        lastNoMatch = err;
        continue;
      }
      throw err;
    }
  }
  throw lastNoMatch || new Error("No dashboards matched selector");
}
