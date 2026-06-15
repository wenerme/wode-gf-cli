import { parseRenderVar } from "./parse-render-var";

export function buildRenderDashboardPath(options: {
  dashboardUid: string;
  from: string;
  to: string;
  width: number;
  height: number;
  scale?: number;
  tz: string;
  theme: "light" | "dark";
  vars: string[];
  renderParams?: string[];
}): string {
  const url = new URL(`/render/d/${encodeURIComponent(options.dashboardUid)}/_`, "http://local");
  url.searchParams.set("from", options.from);
  url.searchParams.set("to", options.to);
  url.searchParams.set("width", String(options.width));
  url.searchParams.set("height", String(options.height));
  if (options.scale !== undefined && options.scale !== 1) {
    url.searchParams.set("scale", String(options.scale));
  }
  url.searchParams.set("tz", options.tz);
  url.searchParams.set("theme", options.theme);

  for (const expr of options.vars) {
    const { key, value } = parseRenderVar(expr);
    url.searchParams.append(`var-${key}`, value);
  }

  for (const expr of options.renderParams || []) {
    const { key, value } = parseRenderVar(expr, "--render-param");
    url.searchParams.append(key, value);
  }

  return `${url.pathname}${url.search}`;
}
