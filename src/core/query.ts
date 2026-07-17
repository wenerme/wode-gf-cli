import type { GrafanaClient } from "../client";
import { asObjectArray, asString, getObjectField } from "../lib/json-narrow";
import { resolveTemplateString, type TemplateVars } from "../lib/template-vars";
import { parseResourceAlias } from "../resources/model";
import type { JsonObject } from "./json";

export type QueryModeFlags = {
  resourceAlias: ReturnType<typeof parseResourceAlias>;
  isDsKeyword: boolean;
  isQuickQueryMode: boolean;
};

export function detectQueryMode(
  resourceArg: string,
  options: { sql?: string; expr?: string; queryJson?: string; queryFile?: string; query?: string[] },
): QueryModeFlags {
  const resourceAlias = parseResourceAlias(resourceArg);
  const isDsKeyword = resourceArg === "ds" || resourceArg === "datasource";
  const isQuickQueryMode =
    Boolean(
      options.sql || options.expr || options.queryJson || options.queryFile || (options.query || []).length,
    ) || isDsKeyword;
  return { resourceAlias, isDsKeyword, isQuickQueryMode };
}

export function resolveQueryDatasourceIdentifier(
  resourceArg: string,
  options: { uid?: string },
  flags: QueryModeFlags,
): string {
  if (flags.resourceAlias && !flags.isDsKeyword && !options.uid) {
    throw new Error(`Resource '${resourceArg}' conflicts with datasource query mode; pass --uid explicitly`);
  }
  let identifier = String(options.uid || "").trim();
  if (!identifier && !flags.isDsKeyword && !flags.resourceAlias) identifier = resourceArg;
  if (!identifier) {
    throw new Error("query datasource requires identifier: use query <uid|name> --sql ... or --uid ...");
  }
  return identifier;
}

export async function resolveDatasourceByIdentifier(
  client: GrafanaClient,
  identifier: string,
  vars: TemplateVars,
): Promise<{ uid: string; name?: string; type?: string; jsonData?: JsonObject }> {
  const resolved = resolveTemplateString(identifier.trim(), vars);
  if (!resolved) throw new Error("Datasource identifier is empty");
  const datasources = asObjectArray(await client.request<unknown[]>("GET", "/api/datasources"));
  const matched = datasources.find(
    (item) => asString(item.uid) === resolved || asString(item.name) === resolved,
  );
  if (!matched) throw new Error(`Datasource not found by uid/name: ${resolved}`);
  const uid = asString(matched.uid);
  if (!uid) throw new Error(`Datasource has no uid: ${resolved}`);
  return {
    uid,
    name: asString(matched.name),
    type: asString(matched.type),
    jsonData: getObjectField(matched, "jsonData"),
  };
}
