import type { GrafanaCliContext } from "./schema";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type QueryParams = Record<string, string | number | boolean | null | undefined>;
type ResponseMode = "auto" | "bytes" | "text";

type RequestInput<I, P extends QueryParams> = {
  name?: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  url: string;
  method?: HttpMethod;
  headers?: HeadersInit;
  body?: I;
  rawBody?: string | Uint8Array;
  params?: P;
  timeoutMs?: number;
  parseAs?: ResponseMode;
};

type RequestResult<O> = {
  status: number;
  headers: Headers;
  data: O | string | Uint8Array;
};

function withQueryParams(url: string, params?: QueryParams): string {
  if (!params || Object.keys(params).length === 0) return url;
  const target = new URL(url, "http://local");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.origin === "http://local" ? `${target.pathname}${target.search}` : target.toString();
}

export async function request<O = unknown, I = unknown, P extends QueryParams = QueryParams>(
  input: RequestInput<I, P>,
): Promise<RequestResult<O>> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const method = input.method ?? "GET";
  const parseAs = input.parseAs ?? "auto";
  const timeoutMs = input.timeoutMs ?? 20_000;

  const baseUrl = input.baseUrl?.replace(/\/+$/, "") || "";
  const rawUrl = input.url.startsWith("http") ? input.url : `${baseUrl}${input.url}`;
  const targetUrl = withQueryParams(rawUrl, input.params);

  const headers = new Headers(input.headers);
  if (input.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(targetUrl, {
      method,
      headers,
      body: input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body)),
      signal: controller.signal,
    });

    if (parseAs === "bytes") {
      const buffer = await response.arrayBuffer();
      return {
        status: response.status,
        headers: response.headers,
        data: new Uint8Array(buffer),
      };
    }

    const text = await response.text();
    if (parseAs === "text") {
      return {
        status: response.status,
        headers: response.headers,
        data: text,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") && text ? (JSON.parse(text) as O) : text;

    return {
      status: response.status,
      headers: response.headers,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function grafanaAuthHeaders(
  ctx: Pick<GrafanaCliContext, "apiKey" | "username" | "password">,
): Record<string, string> {
  if (ctx.apiKey) return { Authorization: `Bearer ${ctx.apiKey}` };
  if (ctx.username) {
    return {
      Authorization: `Basic ${Buffer.from(`${ctx.username}:${ctx.password || ""}`).toString("base64")}`,
    };
  }
  return {};
}

export class GrafanaClient {
  readonly url: string;
  readonly apiKey?: string;
  readonly username?: string;
  readonly password?: string;
  readonly timeoutMs: number;
  readonly debug: boolean;

  constructor(ctx: GrafanaCliContext) {
    this.url = ctx.url.replace(/\/+$/, "");
    this.apiKey = ctx.apiKey;
    this.username = ctx.username;
    this.password = ctx.password;
    this.timeoutMs = ctx.timeoutMs;
    this.debug = ctx.debug;
  }

  async request<T = unknown>(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
    expected: number[] = [200],
    extraHeaders: HeadersInit = {},
  ): Promise<T> {
    const result = await request<T, unknown>({
      name: "grafana-request",
      baseUrl: this.url,
      url: apiPath,
      method,
      headers: {
        Accept: "application/json",
        ...grafanaAuthHeaders(this),
        ...extraHeaders,
      },
      body,
      timeoutMs: this.timeoutMs,
    });
    if (this.debug) console.log(`[DEBUG] ${method} ${this.url}${apiPath}`);

    if (!expected.includes(result.status)) {
      const message = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      throw new Error(`${result.status} ${method} ${apiPath}: ${message}`);
    }
    return result.data as T;
  }

  async requestWithStatus<T = unknown>(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | string }> {
    const result = await request<T, unknown>({
      name: "grafana-request-with-status",
      baseUrl: this.url,
      url: apiPath,
      method,
      headers: {
        Accept: "application/json",
        ...grafanaAuthHeaders(this),
      },
      body,
      timeoutMs: this.timeoutMs,
    });
    if (this.debug) console.log(`[DEBUG] ${method} ${this.url}${apiPath}`);
    return { status: result.status, data: result.data as T | string };
  }

  async requestBytes(method: HttpMethod, apiPath: string, expected: number[] = [200]): Promise<Uint8Array> {
    const result = await request<Uint8Array, undefined>({
      name: "grafana-request-bytes",
      baseUrl: this.url,
      url: apiPath,
      method,
      headers: {
        Accept: "*/*",
        ...grafanaAuthHeaders(this),
      },
      timeoutMs: this.timeoutMs,
      parseAs: "bytes",
    });
    if (this.debug) console.log(`[DEBUG] ${method} ${this.url}${apiPath}`);

    if (!expected.includes(result.status)) {
      throw new Error(`${result.status} ${method} ${apiPath}: unexpected status`);
    }
    return result.data as Uint8Array;
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
