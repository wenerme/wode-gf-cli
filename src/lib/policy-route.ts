import { asObject, asObjectArray, asString } from "./json-narrow";

export type JsonObject = Record<string, unknown>;
export type PolicyMatcher = [string, string, string];

export type PolicyRouteInput = {
  receiver: string;
  matchers: PolicyMatcher[];
  groupBy?: string[];
  groupWait?: string;
  groupInterval?: string;
  repeatInterval?: string;
};

export type PolicyRouteUpsertResult = {
  policy: JsonObject;
  route: JsonObject;
  action: "insert" | "update" | "unchanged";
  path: string;
  previous?: JsonObject;
};

const MatcherPattern = /^\s*([A-Za-z_][A-Za-z0-9_:-]*)\s*(=~|!~|!=|=)\s*(?:(['"])(.*?)\3|(.+?))\s*$/;

export function parsePolicyMatcher(input: string): PolicyMatcher {
  const match = MatcherPattern.exec(input);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid matcher: ${input}`);
  const value = (match[4] ?? match[5] ?? "").trim();
  if (!value) throw new Error(`Invalid matcher: ${input}. Missing value`);
  return [match[1], match[2], value];
}

export function parseGroupBy(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const values = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function routeMatchers(route: JsonObject): PolicyMatcher[] {
  const objectMatchers = route.object_matchers;
  if (Array.isArray(objectMatchers)) {
    return objectMatchers
      .map((item) => (Array.isArray(item) ? item : []))
      .filter((item) => item.length >= 3)
      .map((item) => [String(item[0]), String(item[1]), String(item[2])] as PolicyMatcher);
  }

  return asObjectArray(route.matchers)
    .map((item) => parsePolicyMatcher(String(item)))
    .filter(Boolean);
}

export function matcherKey(matchers: PolicyMatcher[]): string {
  return matchers
    .map(([name, op, value]) => `${name}${op}${value}`)
    .sort()
    .join("&&");
}

function buildRoute(input: PolicyRouteInput): JsonObject {
  const route: JsonObject = {
    receiver: input.receiver,
    object_matchers: input.matchers,
  };
  if (input.groupBy) route.group_by = input.groupBy;
  if (input.groupWait) route.group_wait = input.groupWait;
  if (input.groupInterval) route.group_interval = input.groupInterval;
  if (input.repeatInterval) route.repeat_interval = input.repeatInterval;
  return route;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function routeEqual(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(normalizeRoute(a)) === JSON.stringify(normalizeRoute(b));
}

function normalizeRoute(route: JsonObject): JsonObject {
  const normalized = { ...route, object_matchers: routeMatchers(route) };
  delete normalized.matchers;
  return sortObject(normalized) as JsonObject;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function upsertPolicyRoute(policyInput: JsonObject, input: PolicyRouteInput): PolicyRouteUpsertResult {
  const policy = clone(policyInput);
  const routes = Array.isArray(policy.routes) ? (policy.routes as unknown[]) : [];
  policy.routes = routes;
  const desired = buildRoute(input);
  const desiredKey = matcherKey(input.matchers);

  for (let index = 0; index < routes.length; index += 1) {
    const route = asObject(routes[index]);
    if (!route) continue;
    if (matcherKey(routeMatchers(route)) !== desiredKey) continue;
    const next = { ...route, ...desired };
    routes[index] = next;
    return {
      policy,
      route: next,
      action: routeEqual(route, next) ? "unchanged" : "update",
      path: `routes[${index}]`,
      previous: route,
    };
  }

  routes.push(desired);
  return { policy, route: desired, action: "insert", path: `routes[${routes.length - 1}]` };
}

export function findMatchingPolicyRoute(
  policy: JsonObject,
  labels: Record<string, string>,
): JsonObject | undefined {
  const visit = (route: JsonObject): JsonObject | undefined => {
    for (const child of asObjectArray(route.routes)) {
      const match = visit(child);
      if (match) return match;
    }
    if (routeMatchers(route).length > 0 && routeMatchesLabels(route, labels)) return route;
    return undefined;
  };
  return visit(policy);
}

export function routeMatchesLabels(route: JsonObject, labels: Record<string, string>): boolean {
  const matchers = routeMatchers(route);
  if (matchers.length === 0) return false;
  return matchers.every(([name, op, expected]) => {
    const actual = labels[name] || "";
    if (op === "=") return actual === expected;
    if (op === "!=") return actual !== expected;
    if (op === "=~") return new RegExp(expected).test(actual);
    if (op === "!~") return !new RegExp(expected).test(actual);
    return false;
  });
}

export function routeLabel(route: JsonObject): string {
  const receiver = asString(route.receiver) || "(no receiver)";
  const matchers = routeMatchers(route)
    .map(([name, op, value]) => `${name}${op}"${value}"`)
    .join(", ");
  return `${matchers || "(root)"} -> ${receiver}`;
}
