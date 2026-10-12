import { createHash } from "node:crypto";
import { formatRect } from "./check";
import type { LayoutGraph, LayoutItem } from "./graph";

export type LayoutChange = {
  change: "added" | "removed" | "moved" | "resized" | "reparented" | "options";
  key: string;
  title?: string;
  from?: string;
  to?: string;
};

export type LayoutDiff = {
  changed: boolean;
  items: LayoutChange[];
  containers: { added: string[]; removed: string[]; reordered: boolean; changed: string[] };
};

function itemSignature(item: LayoutItem) {
  const rect = item.rect
    ? [item.rect.x, item.rect.y, item.rect.w, item.rect.h].map((v) => (Number.isNaN(v) ? "NaN" : v))
    : null;
  return [item.key, item.container, rect, item.extra ?? null];
}

function sameNumber(a: number, b: number) {
  return Object.is(a, b);
}

/** Stable hash of layout-only data (positions, membership, container order and options). */
export function layoutFingerprint(graph: LayoutGraph): string {
  const payload = JSON.stringify({
    containers: graph.containers.map((container) => [
      container.kind,
      container.container,
      container.collapsed === true,
      container.props ?? null,
    ]),
    items: graph.items.map(itemSignature),
    unknown: graph.unknownKinds.map((unknown) => [unknown.kind, unknown.path, unknown.signature ?? null]),
    missing: graph.missingLayouts,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function where(item: LayoutItem): string {
  return `${item.container || "(root)"} ${formatRect(item.rect)}`;
}

export function diffLayout(base: LayoutGraph, next: LayoutGraph): LayoutDiff {
  const before = new Map(base.items.map((item) => [item.key, item]));
  const after = new Map(next.items.map((item) => [item.key, item]));
  const items: LayoutChange[] = [];

  for (const [key, item] of before) {
    const other = after.get(key);
    if (!other) {
      items.push({ change: "removed", key, title: item.title, from: where(item) });
      continue;
    }
    if (item.container !== other.container) {
      items.push({ change: "reparented", key, title: other.title, from: where(item), to: where(other) });
      continue;
    }
    const a = item.rect;
    const b = other.rect;
    if (a && b && (!sameNumber(a.w, b.w) || !sameNumber(a.h, b.h))) {
      items.push({ change: "resized", key, title: other.title, from: formatRect(a), to: formatRect(b) });
    } else if (a && b && (!sameNumber(a.x, b.x) || !sameNumber(a.y, b.y))) {
      items.push({ change: "moved", key, title: other.title, from: formatRect(a), to: formatRect(b) });
    } else if (Boolean(a) !== Boolean(b) || item.extra !== other.extra) {
      items.push({ change: "options", key, title: other.title, from: item.extra, to: other.extra });
    }
  }
  for (const [key, item] of after) {
    if (!before.has(key)) items.push({ change: "added", key, title: item.title, to: where(item) });
  }

  const baseContainers = base.containers.map((container) => container.container);
  const nextContainers = next.containers.map((container) => container.container);
  const added = nextContainers.filter((name) => !baseContainers.includes(name));
  const removed = baseContainers.filter((name) => !nextContainers.includes(name));
  const common = (list: string[], other: string[]) => list.filter((name) => other.includes(name));
  const reordered =
    JSON.stringify(common(baseContainers, nextContainers)) !==
    JSON.stringify(common(nextContainers, baseContainers));

  const props = (graph: LayoutGraph) =>
    new Map(
      graph.containers.map((container) => [
        container.container,
        `${container.collapsed}|${container.props ?? ""}`,
      ]),
    );
  const beforeProps = props(base);
  const afterProps = props(next);
  const changedContainers = [...afterProps.keys()].filter(
    (name) => beforeProps.has(name) && beforeProps.get(name) !== afterProps.get(name),
  );
  const structural =
    items.length > 0 || added.length > 0 || removed.length > 0 || reordered || changedContainers.length > 0;
  return {
    // Fingerprint is the source of truth; item/container lists explain it.
    changed: structural || layoutFingerprint(base) !== layoutFingerprint(next),
    items,
    containers: { added, removed, reordered, changed: changedContainers },
  };
}
