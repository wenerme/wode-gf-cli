import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { grafanaAuthHeaders, request } from "../client";
import type { CommandAppContext } from "./runtime";

type ApiOptions = {
  method?: string;
  header?: string[];
  query?: string[];
  field?: string[];
  json?: string;
  data?: string;
  dataFile?: string;
  out?: string;
  include?: boolean;
  raw?: boolean;
  fail?: boolean;
};

type ApiBody = {
  body?: unknown;
  rawBody?: string;
  contentType?: string;
};

const NoBodyMethods = new Set(["GET", "HEAD"]);

export function buildApiCommand(app: CommandAppContext) {
  const { collectList, runtime } = app;
  const { parseCommonOptions, printMessage } = runtime;

  return new Command("api")
    .argument("<path>", "Grafana API path (for example /api/org) or absolute URL")
    .description("Call raw Grafana HTTP API as an escape hatch")
    .option("-X, --method <method>", "HTTP method, default GET or POST when a body is provided")
    .option("-H, --header <header>", "HTTP header, repeatable: 'Name: value'", collectList, [])
    .option("--query <expr>", "query parameter key=value, repeatable", collectList, [])
    .option("-f, --field <expr>", "JSON field key=value, repeatable", collectList, [])
    .option("--json <json>", "JSON request body; use @file or @- to read from file/stdin")
    .option("-d, --data <body>", "raw request body; use @file or @- to read from file/stdin")
    .option("--data-file <file>", "raw request body file; use - for stdin")
    .option("-i, --include", "include status and response headers in text output")
    .option("--raw", "print response body without JSON pretty formatting")
    .option("--fail", "exit non-zero on non-2xx responses")
    .option("-o, --out <file>", "write response body to file")
    .action(async function apiAction(apiPath: string, options: ApiOptions) {
      const ctx = parseCommonOptions(this as unknown as Command);
      const headers = new Headers({ Accept: "application/json", ...grafanaAuthHeaders(ctx) });
      for (const header of options.header || []) {
        const parsed = parseHeader(header);
        headers.set(parsed.name, parsed.value);
      }

      const body = readApiBody(options);
      if (body.contentType && !headers.has("Content-Type")) headers.set("Content-Type", body.contentType);
      const method = normalizeMethod(options.method || (hasApiBody(body) ? "POST" : "GET"));
      if (hasApiBody(body) && NoBodyMethods.has(method)) {
        throw new Error(`${method} request cannot include a body`);
      }

      const response = await request<unknown, unknown>({
        name: "grafana-api",
        baseUrl: ctx.url,
        url: normalizeApiPath(apiPath),
        method,
        headers,
        params: parseQueryParams(options.query || []),
        body: body.body,
        rawBody: body.rawBody,
        timeoutMs: ctx.timeoutMs,
        parseAs: options.raw ? "text" : "auto",
      });

      const responseHeaders = headersToObject(response.headers);
      const statusOk = response.status >= 200 && response.status < 300;
      if (options.out) {
        writeApiOutput(options.out, response.data);
        printMessage(ctx, `Wrote response body to ${path.resolve(options.out)}`);
      } else if (ctx.output === "json") {
        console.log(
          JSON.stringify(
            {
              type: "api-response",
              status: response.status,
              ok: statusOk,
              headers: responseHeaders,
              body: response.data,
            },
            null,
            2,
          ),
        );
      } else {
        if (options.include) {
          console.log(`HTTP ${response.status}`);
          for (const [name, value] of Object.entries(responseHeaders)) console.log(`${name}: ${value}`);
          console.log("");
        }
        printApiBody(response.data, Boolean(options.raw));
      }

      if (options.fail && !statusOk) process.exitCode = 1;
    });
}

function normalizeApiPath(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Missing API path");
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeMethod(input: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" {
  const method = input.trim().toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    return method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  }
  throw new Error(`Unsupported HTTP method: ${input}`);
}

function parseHeader(input: string): { name: string; value: string } {
  const index = input.indexOf(":");
  if (index <= 0) throw new Error(`Invalid header: ${input}. Expect 'Name: value'`);
  const name = input.slice(0, index).trim();
  const value = input.slice(index + 1).trim();
  if (!name) throw new Error(`Invalid header: ${input}. Missing header name`);
  return { name, value };
}

function parseQueryParams(items: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const item of items) {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --query: ${item}. Expect key=value`);
    const key = item.slice(0, index).trim();
    if (!key) throw new Error(`Invalid --query: ${item}. Missing key`);
    params[key] = item.slice(index + 1);
  }
  return params;
}

function readApiBody(options: ApiOptions): ApiBody {
  const bodySources = [
    options.json !== undefined,
    options.data !== undefined,
    options.dataFile !== undefined,
    (options.field || []).length > 0,
  ].filter(Boolean).length;
  if (bodySources > 1) throw new Error("Use only one of --field, --json, --data, or --data-file");

  if ((options.field || []).length > 0) {
    return { body: parseFields(options.field || []), contentType: "application/json" };
  }

  if (options.json !== undefined) {
    const raw = readValueOrFile(options.json, "--json");
    try {
      return { body: JSON.parse(raw) as unknown, contentType: "application/json" };
    } catch (error) {
      throw new Error(`Invalid --json body: ${(error as Error).message}`);
    }
  }

  if (options.data !== undefined) {
    return { rawBody: readValueOrFile(options.data, "--data"), contentType: "text/plain" };
  }

  if (options.dataFile !== undefined) {
    return { rawBody: readFileReference(options.dataFile), contentType: "application/octet-stream" };
  }

  return {};
}

function hasApiBody(body: ApiBody): boolean {
  return body.body !== undefined || body.rawBody !== undefined;
}

function parseFields(items: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const item of items) {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --field: ${item}. Expect key=value`);
    const key = item.slice(0, index).trim();
    if (!key) throw new Error(`Invalid --field: ${item}. Missing key`);
    body[key] = parseFieldValue(item.slice(index + 1));
  }
  return body;
}

function parseFieldValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readValueOrFile(value: string, label: string): string {
  if (value === "@-") return fs.readFileSync(0, "utf8");
  if (value.startsWith("@")) return readFileReference(value.slice(1));
  if (!value && label === "--json") throw new Error("--json cannot be empty");
  return value;
}

function readFileReference(file: string): string {
  if (file === "-") return fs.readFileSync(0, "utf8");
  if (!file) throw new Error("Missing file path");
  return fs.readFileSync(path.resolve(file), "utf8");
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    output[name] = value;
  });
  return output;
}

function printApiBody(data: unknown, raw: boolean) {
  if (raw) {
    process.stdout.write(typeof data === "string" ? data : JSON.stringify(data));
    if (typeof data !== "string") process.stdout.write("\n");
    return;
  }

  if (typeof data === "string") {
    process.stdout.write(data);
    if (!data.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  console.log(JSON.stringify(data, null, 2));
}

function writeApiOutput(file: string, data: unknown) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export const __test__ = {
  normalizeApiPath,
  parseHeader,
  parseQueryParams,
};
