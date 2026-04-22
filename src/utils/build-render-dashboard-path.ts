import { parseRenderVar } from "./parse-render-var";

export function buildRenderDashboardPath(options: {
  dashboardUid: string;
  from: string;
  to: string;
  width: number;
  height: number;
  tz: string;
  theme: "light" | "dark";
  vars: string[];
}): string {
  const url = new URL(`/render/d/${encodeURIComponent(options.dashboardUid)}/_`, "http://local");
  url.searchParams.set("from", options.from);
  url.searchParams.set("to", options.to);
  url.searchParams.set("width", String(options.width));
  url.searchParams.set("height", String(options.height));
  url.searchParams.set("tz", options.tz);
  url.searchParams.set("theme", options.theme);

  for (const expr of options.vars) {
    const { key, value } = parseRenderVar(expr);
    url.searchParams.append(`var-${key}`, value);
  }

  return `${url.pathname}${url.search}`;
}
