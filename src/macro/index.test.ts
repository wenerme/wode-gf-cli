import { describe, expect, it } from "vitest";
import {
  createDefaultGrafanaMacroRegistry,
  interpolateMacros,
  parseMacros,
  splitMacroArgs,
  stripComments,
} from "./index";

const dsUid = "$" + "{__ds.uid}";
const timeFrom = "$" + "{__timeFrom}";
const formattedTimeFrom = "$" + "{__timeFrom:date:YYYY-MM-DD}";
const secondsTimeFrom = "$" + "{__timeFrom:date:seconds}";

describe("macro utilities", () => {
  it("parses zero-arg and argument macro calls", () => {
    expect(parseMacros("$__interval $__timeGroup(created_at, $__interval)")).toEqual([
      {
        type: "Macro",
        raw: "$__interval",
        name: "interval",
        args: [],
        rawArgs: [],
        start: 0,
        end: 11,
        braced: false,
      },
      {
        type: "Macro",
        raw: "$__timeGroup(created_at, $__interval)",
        name: "timeGroup",
        args: ["created_at", "$__interval"],
        rawArgs: ["created_at", " $__interval"],
        start: 12,
        end: 49,
        braced: false,
      },
    ]);
  });

  it("parses braced metadata and formatted time macros", () => {
    expect(parseMacros(`${dsUid} ${formattedTimeFrom}`)).toEqual([
      {
        type: "Macro",
        raw: dsUid,
        name: "__ds.uid",
        args: [],
        rawArgs: [],
        start: 0,
        end: 11,
        braced: true,
        format: undefined,
      },
      {
        type: "Macro",
        raw: formattedTimeFrom,
        name: "__timeFrom",
        args: [],
        rawArgs: [],
        start: 12,
        end: 41,
        braced: true,
        format: "date:YYYY-MM-DD",
      },
    ]);
  });

  it("splits args with nested parens and strings", () => {
    expect(splitMacroArgs("COALESCE(a, b), 'x,y', $__interval")).toEqual([
      "COALESCE(a, b)",
      " 'x,y'",
      " $__interval",
    ]);
    expect(parseMacros("$__wrap(COALESCE(a, b), 'x,y')")[0]?.args).toEqual(["COALESCE(a, b)", "'x,y'"]);
  });

  it("keeps unknown macros and interpolates registered handlers", () => {
    const out = interpolateMacros(
      "SELECT $__known(a, b), $__unknown(x)",
      {
        known: (_ctx, macro) => macro.args.join("+"),
      },
      {},
    );
    expect(out).toBe("SELECT a+b, $__unknown(x)");
  });

  it("supports default Grafana macro handlers", () => {
    const out = interpolateMacros(
      "WHERE $__timeFilter(created_at) GROUP BY $__interval $__interval_ms",
      createDefaultGrafanaMacroRegistry(),
      {
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T01:00:00Z"),
        interval: "5m",
        intervalMs: 300000,
      },
    );

    expect(out).toBe(
      "WHERE created_at >= '2024-01-01T00:00:00.000Z' AND created_at <= '2024-01-01T01:00:00.000Z' GROUP BY 5m 300000",
    );
  });

  it("supports Infinity time, customInterval, combineValues, and metadata macros", () => {
    const registry = createDefaultGrafanaMacroRegistry();
    expect(
      interpolateMacros(`${timeFrom} ${secondsTimeFrom} ${formattedTimeFrom}`, registry, {
        from: new Date("2020-07-13T20:19:09.254Z"),
      }),
    ).toBe("1594671549254 1594671549 2020-07-13");
    expect(
      interpolateMacros("$__customInterval(5m,5 MINUTES,1d,1 DAY,10d,10 days,1d)", registry, {
        rangeMs: 7 * 86_400_000,
      }),
    ).toBe("10 days");
    expect(interpolateMacros("$__combineValues(__open,__close, OR ,foo,bar)", registry)).toBe(
      "(foo) OR (bar)",
    );
    expect(interpolateMacros("$__combineValues(p,s,i,*)", registry)).toBe("");
    expect(interpolateMacros(dsUid, registry, { vars: { "__ds.uid": "ds-1" } })).toBe("ds-1");
  });

  it("strips comments without touching strings", () => {
    expect(stripComments("select '$__x' -- $__hidden\n$__visible", ["line"])).toBe(
      "select '$__x'             \n$__visible",
    );
  });
});
