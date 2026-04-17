import { z } from "zod";

export const CliName = "wode-gf-cli";

export const DefaultResources = [
  "folders",
  "dashboards",
  "datasources",
  "alert-rules",
  "contact-points",
  "policies",
] as const;

export const ResourceNameSchema = z.enum(DefaultResources);
export type ResourceName = z.infer<typeof ResourceNameSchema>;

export const GrafanaCliContextSchema = z.object({
  url: z.string(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(1000),
  dryRun: z.boolean(),
  debug: z.boolean(),
  profile: z.string().optional(),
});
export type GrafanaCliContext = z.infer<typeof GrafanaCliContextSchema>;

export const ExportBundleSchema = z.object({
  generatedAt: z.string(),
  profile: z.string().optional(),
  url: z.string(),
  resources: z.array(ResourceNameSchema),
  folders: z.array(z.unknown()).optional(),
  dashboards: z.array(z.unknown()).optional(),
  datasources: z.array(z.unknown()).optional(),
  "alert-rules": z.array(z.unknown()).optional(),
  "contact-points": z.array(z.unknown()).optional(),
  policies: z.unknown().optional(),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export const DiffItemSchema = z.object({
  key: z.string(),
  change: z.enum(["added", "removed", "changed"]),
});
export type DiffItem = z.infer<typeof DiffItemSchema>;

export const ResourceSelectorSchema = z.object({
  id: z.string().optional(),
  uid: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  where: z.array(z.string()).default([]),
});
export type ResourceSelector = z.infer<typeof ResourceSelectorSchema>;

export const SetExprSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
});

export const WhereExprSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
});

export const RenderPanelOptionsSchema = z.object({
  dashboardUid: z.string().min(1),
  panelId: z.number().int().positive(),
  out: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  width: z.number().int().min(100).max(4000),
  height: z.number().int().min(100).max(4000),
  tz: z.string().min(1),
  theme: z.enum(["light", "dark"]),
  vars: z.array(z.string()).default([]),
});
export type RenderPanelOptions = z.infer<typeof RenderPanelOptionsSchema>;
