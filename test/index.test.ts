import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { health } from "../src/index.ts";

describe("health", () => {
  it("reports ok", () => {
    assert.deepEqual(health(), { status: "ok" });
  });
});
