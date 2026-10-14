/**
 * Structural JSON diff for reviewing resource versions.
 *
 * Arrays whose items all carry a unique identity (id/uid/refId/name/...) are compared by identity, so inserting
 * one panel reports one `added` change instead of rewriting every later index. Other arrays compare by index.
 */
export type JsonChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

const IdentityKeys = ["id", "uid", "refId", "name", "key"] as const;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function identityKey(items: unknown[]): string | undefined {
  if (items.length === 0) return undefined;
  for (const key of IdentityKeys) {
    const seen = new Set<string>();
    const ok = items.every((item) => {
      if (!isPlain(item)) return false;
      const value = item[key];
      if (typeof value !== "string" && typeof value !== "number") return false;
      const token = `${typeof value}:${value}`;
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
    if (ok) return key;
  }
  return undefined;
}

const segment = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
const literal = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : String(value));

export function diffJson(before: unknown, after: unknown, root = "$"): JsonChange[] {
  const changes: JsonChange[] = [];
  walk(before, after, root, changes);
  return changes;
}

function walk(before: unknown, after: unknown, path: string, out: JsonChange[]) {
  if (isPlain(before) && isPlain(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const next = `${path}${segment(key)}`;
      if (!(key in after)) out.push({ path: next, kind: "removed", before: before[key] });
      else if (!(key in before)) out.push({ path: next, kind: "added", after: after[key] });
      else walk(before[key], after[key], next, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const key =
      identityKey(before) && identityKey(before) === identityKey(after) ? identityKey(before) : undefined;
    if (key) {
      const index = (items: unknown[]) => new Map(items.map((item) => [(item as Plain)[key], item]));
      const left = index(before);
      const right = index(after);
      for (const [id, item] of left) {
        const next = `${path}[?(@.${key}==${literal(id)})]`;
        if (!right.has(id)) out.push({ path: next, kind: "removed", before: item });
        else walk(item, right.get(id), next, out);
      }
      for (const [id, item] of right) {
        if (!left.has(id))
          out.push({ path: `${path}[?(@.${key}==${literal(id)})]`, kind: "added", after: item });
      }
      const order = (items: unknown[]) =>
        items.map((item) => (item as Plain)[key]).filter((id) => left.has(id) && right.has(id));
      const a = order(before);
      const b = order(after);
      if (a.some((id, i) => id !== b[i]))
        out.push({ path: `${path}#order`, kind: "changed", before: a, after: b });
      return;
    }
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      const next = `${path}[${i}]`;
      if (i >= after.length) out.push({ path: next, kind: "removed", before: before[i] });
      else if (i >= before.length) out.push({ path: next, kind: "added", after: after[i] });
      else walk(before[i], after[i], next, out);
    }
    return;
  }
  if (!Object.is(before, after) && JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, kind: "changed", before, after });
  }
}

/** One line per change; long values are summarized so a whole panel does not flood the terminal. */
export function formatJsonChanges(changes: JsonChange[], maxValue = 120): string[] {
  const show = (value: unknown) => {
    if (value === undefined) return "";
    const text = JSON.stringify(value);
    if (text.length <= maxValue) return text;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (isPlain(value)) {
      const title = typeof value.title === "string" ? ` "${value.title}"` : "";
      return `{${Object.keys(value).length} keys${title}}`;
    }
    return `${text.slice(0, maxValue - 3)}...`;
  };
  return changes.map((change) => {
    if (change.kind === "added") return `+ ${change.path} = ${show(change.after)}`;
    if (change.kind === "removed") return `- ${change.path} (was ${show(change.before)})`;
    return `~ ${change.path}: ${show(change.before)} -> ${show(change.after)}`;
  });
}
