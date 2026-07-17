import { describe, expect, it } from "vitest";
import { __test__ } from "./cli";
import { parsePanelRef, replacePanelInDashboard } from "./commands/build-panel";

describe("cli internal unit tests", () => {
  it("builds validate query body for CLS logService targets", () => {
    const body = __test__.buildValidateQueryBody(
      {
        refId: "A",
        raw: {
          refId: "A",
          serviceType: "logService",
          datasource: { type: "tencent-cls-grafana-datasource", uid: "$" + "{cls_ds}" },
          logServiceParams: {
            TopicId: "$" + "{topic}",
            SyntaxRule: 1,
            format: "Table Panel",
            Query: 'msg:"RequestDone" $' + "{filter:raw} | SELECT count(*) as value FROM log",
          },
        },
      },
      {
        datasourceUid: "cls-uid",
        vars: { cls_ds: "cls-uid", topic: "sample-topic", filter: 'user_id:"u1"' },
        fromMs: 0,
        toMs: 3_600_000,
        intervalMs: 60_000,
      },
    );

    expect(body?.serviceType).toBe("logService");
    expect(body?.datasource).toEqual({ type: "tencent-cls-grafana-datasource", uid: "cls-uid" });
    expect(body?.logServiceParams).toMatchObject({
      TopicId: "sample-topic",
      SyntaxRule: 1,
      format: "Table Panel",
      Query: 'msg:"RequestDone" user_id:"u1" | SELECT count(*) as value FROM log',
    });
  });

  it("gets and sets nested path values", () => {
    const target: Record<string, unknown> = {};
    __test__.setPathValue(target, "a.b[0].name", "sample-user");
    expect(__test__.getPathValue(target, "a.b[0].name")).toBe("sample-user");
  });

  it("parses panel refs and replaces nested panels", () => {
    expect(parsePanelRef("dash-uid/12")).toEqual({ dashboard: "dash-uid", panelId: 12 });
    expect(() => parsePanelRef("dash-uid")).toThrow("Panel ref must be DASH/PANEL");
    expect(() => parsePanelRef("dash-uid/panel-a")).toThrow("numeric panel id");

    const dashboard = {
      panels: [
        { id: 1, title: "A" },
        { id: 2, title: "Row", panels: [{ id: 3, title: "Nested" }] },
      ],
    };
    const updated = replacePanelInDashboard(dashboard, 3, { id: 3, title: "Next" });
    expect(updated.panels[1]?.panels?.[0]?.title).toBe("Next");
    expect(dashboard.panels[1]?.panels?.[0]?.title).toBe("Nested");
  });

  it("deep merges objects and replaces arrays", () => {
    const merged = __test__.deepMerge(
      { a: { b: 1 }, arr: [1, 2], keep: true },
      { a: { c: 2 }, arr: [3], next: "x" },
    ) as {
      a: { b: number; c: number };
      arr: number[];
      keep: boolean;
      next: string;
    };

    expect(merged.a).toEqual({ b: 1, c: 2 });
    expect(merged.arr).toEqual([3]);
    expect(merged.keep).toBe(true);
    expect(merged.next).toBe("x");
  });
});
