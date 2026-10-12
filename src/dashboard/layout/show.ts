import { describeItem, formatRect } from "./check";
import type { LayoutGraph, LayoutItem } from "./graph";

function depth(container: string): number {
  return container ? container.split("/").length : 0;
}

function itemLine(item: LayoutItem, indent: number): string {
  const repeat = item.extra?.includes("repeat") ? " (repeat)" : "";
  return `${"  ".repeat(indent)}- ${describeItem(item)}  ${formatRect(item.rect)}${repeat}`;
}

/** Render the layout tree as indented text (tabs/rows/panels with coordinates). */
export function renderLayoutTree(graph: LayoutGraph): string {
  const lines = [`${graph.title} [${graph.format}${graph.uid ? ` uid=${graph.uid}` : ""}]`];
  const byContainer = new Map<string, LayoutItem[]>();
  for (const item of graph.items) {
    if (item.isRow) continue;
    byContainer.set(item.container, [...(byContainer.get(item.container) || []), item]);
  }
  for (const item of byContainer.get("") || []) lines.push(itemLine(item, 1));
  const seen = new Set<string>();
  for (const container of graph.containers) {
    if (container.kind === "autogrid" || seen.has(container.container)) continue;
    seen.add(container.container);
    const level = depth(container.container);
    const name = container.container.split("/").at(-1) || container.container;
    lines.push(`${"  ".repeat(level)}${name}${container.collapsed ? " (collapsed)" : ""}`);
    for (const item of byContainer.get(container.container) || []) lines.push(itemLine(item, level + 1));
  }
  for (const unknown of graph.unknownKinds)
    lines.push(`  ? ${unknown.kind} at ${unknown.path} (not understood)`);
  return lines.join("\n");
}
