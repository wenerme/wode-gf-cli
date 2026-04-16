import type { GrafanaCliContext } from "./schema";

export class GrafanaClient {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly debug: boolean;

  constructor(ctx: GrafanaCliContext) {
    this.url = ctx.url.replace(/\/+$/, "");
    this.apiKey = ctx.apiKey;
    this.timeoutMs = ctx.timeoutMs;
    this.debug = ctx.debug;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    apiPath: string,
    body?: unknown,
    expected: number[] = [200],
  ): Promise<T> {
    const url = apiPath.startsWith("http") ? apiPath : `${this.url}${apiPath}`;
    const headers = new Headers({ Accept: "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.debug) console.log(`[DEBUG] ${method} ${url}`);
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") && text ? JSON.parse(text) : text;

      if (!expected.includes(response.status)) {
        const message = typeof data === "string" ? data : JSON.stringify(data);
        throw new Error(`${response.status} ${method} ${apiPath}: ${message}`);
      }

      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const result: R[] = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      const item = items[current];
      if (item === undefined) break;
      result[current] = await fn(item, current);
    }
  });

  await Promise.all(workers);
  return result;
}
