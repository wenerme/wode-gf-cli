import { asObjectArray, asString } from "../../lib/json-narrow";
import type { ResourceName, ResourceSelector } from "../../schema";
import { ResourceSelectorSchema } from "../../schema";
import type { CliContext, CommandAppContext } from "../runtime";

export type JsonObject = Record<string, unknown>;

export type ResourceRow = {
  uid: string;
  label: string;
  folder?: string;
  raw: JsonObject;
};

type FolderNode = {
  uid: string;
  title: string;
  parentUid?: string;
  raw: JsonObject;
};

export function printResourceRows(
  app: CommandAppContext,
  ctx: CliContext,
  rows: ResourceRow[],
  options: { json?: boolean },
) {
  if (options.json || ctx.output === "json") {
    console.log(
      JSON.stringify(
        rows.map((row) => row.raw),
        null,
        2,
      ),
    );
    return;
  }
  app.runtime.printMessage(ctx, app.runtime.rowsToTable(rows));
}

export function buildFolderMap(folders: unknown): Map<string, string> {
  const folderMap = new Map<string, string>();
  for (const folder of asObjectArray(folders)) {
    const uid = asString(folder.uid);
    const title = asString(folder.title);
    if (uid && title) folderMap.set(uid, title);
  }
  return folderMap;
}

function buildFolderNodes(folders: unknown): FolderNode[] {
  const nodes: FolderNode[] = [];
  for (const folder of asObjectArray(folders)) {
    const uid = asString(folder.uid);
    const title = asString(folder.title);
    if (!uid || !title) continue;
    nodes.push({ uid, title, parentUid: asString(folder.parentUid), raw: folder });
  }
  return nodes;
}

export function renderFolderTree(folders: unknown): string {
  const nodes = buildFolderNodes(folders);
  if (nodes.length === 0) return "";

  const byParent = new Map<string, FolderNode[]>();
  for (const node of nodes) {
    const key = node.parentUid || "__root__";
    const list = byParent.get(key) || [];
    list.push(node);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
  }

  const lines: string[] = [];
  const visit = (parentUid: string | undefined, depth: number) => {
    const key = parentUid || "__root__";
    for (const node of byParent.get(key) || []) {
      lines.push(`${"  ".repeat(depth)}- ${node.title} [${node.uid}]`);
      visit(node.uid, depth + 1);
    }
  };

  visit(undefined, 0);

  const missingRoots = nodes
    .filter((node) => node.parentUid && !nodes.some((candidate) => candidate.uid === node.parentUid))
    .sort((a, b) => a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid));
  for (const node of missingRoots) {
    if (lines.some((line) => line.endsWith(`[${node.uid}]`))) continue;
    lines.push(`- ${node.title} [${node.uid}]`);
    visit(node.uid, 1);
  }

  return lines.join("\n");
}

function buildTokenSelectors(resource: ResourceName, token: string): ResourceSelector[] {
  const selectors: ResourceSelector[] = [];
  if (/^\d+$/.test(token)) {
    selectors.push(ResourceSelectorSchema.parse({ id: token, uid: token, where: [] }));
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  } else {
    selectors.push(ResourceSelectorSchema.parse({ uid: token, where: [] }));
  }

  if (resource === "folders" || resource === "dashboards" || resource === "alert-rules") {
    selectors.push(ResourceSelectorSchema.parse({ title: token, where: [] }));
  }
  if (resource === "datasources" || resource === "contact-points") {
    selectors.push(ResourceSelectorSchema.parse({ name: token, where: [] }));
  }
  return selectors;
}

export function selectResourceByToken(
  items: unknown[],
  resource: ResourceName,
  token: string,
  selectResource: CommandAppContext["runtime"]["selectResource"],
): unknown {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Missing selector token");

  let lastNoMatch: Error | undefined;
  for (const selector of buildTokenSelectors(resource, trimmed)) {
    try {
      return selectResource(items, resource, selector, false);
    } catch (error) {
      const err = error as Error;
      if (err.message === `No ${resource} matched selector`) {
        lastNoMatch = err;
        continue;
      }
      throw err;
    }
  }

  throw lastNoMatch || new Error(`No ${resource} matched selector`);
}

export function collectVariadic(value: string, previous: string[][]) {
  previous.push([value]);
  return previous;
}

export function parseJsonPathValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parsePanelIds(panelId: string | undefined): string[] | undefined {
  const text = String(panelId || "ALL").trim();
  if (!text || text.toUpperCase() === "ALL") return undefined;
  const ids = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid --panel-id value: ${panelId}`);
  }
  return ids;
}

/**
 * Resolve relative patch paths against panel objects.
 * classic: `$..panels[?(@.id==N)].<path>`; v2: `$.spec.elements[?(@.spec.id==N)].spec.<path>`.
 */
export function panelScopedJsonPathsFor(
  format: "classic" | "v2",
  panelId: string | undefined,
  pathExpr: string,
  v2Root = "$",
): string[] {
  if (format === "classic") return panelScopedJsonPaths(panelId, pathExpr);
  const path = pathExpr.trim();
  if (!path) throw new Error("Missing patch path");
  if (path.startsWith("$")) return [path];
  const ids = parsePanelIds(panelId);
  const selector = ids ? `?(${ids.map((id) => `@.spec.id==${id}`).join(" || ")})` : "*";
  return [`${v2Root}.spec.elements[${selector}].spec.${path}`];
}

function parsePanelIdFilter(panelId: string | undefined) {
  const text = String(panelId || "ALL").trim();
  if (!text || text.toUpperCase() === "ALL") return "*";
  const ids = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length === 0) return "*";
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid --panel-id value: ${panelId}`);
  }
  return `?(${ids.map((id) => `@.id==${id}`).join(" || ")})`;
}

export function panelScopedJsonPaths(panelId: string | undefined, pathExpr: string) {
  const path = pathExpr.trim();
  if (!path) throw new Error("Missing patch path");
  if (path.startsWith("$")) return [path];
  const selector = parsePanelIdFilter(panelId);
  return [`$..panels[${selector}].${path}`];
}
