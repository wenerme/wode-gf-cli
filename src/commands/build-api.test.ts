import { describe, expect, it } from "vitest";
import { __test__ } from "./build-api";

describe("raw API output safety", () => {
  it("redacts sensitive response headers", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "set-cookie": "session=private",
      "x-api-key": "private",
    });

    expect(__test__.headersToObject(headers)).toEqual({
      "content-type": "application/json",
      "set-cookie": "<redacted>",
      "x-api-key": "<redacted>",
    });
  });
});
