import { describe, expect, test } from "bun:test";
import { assertFixture, loadExpected, loadFixture } from "../../scripts/demo-lib.ts";

describe("Northstar deterministic demo fixture", () => {
  test("contains six stable conversations in chronological order", async () => {
    const fixture = await loadFixture();
    expect(() => assertFixture(fixture)).not.toThrow();
    expect(fixture.conversations).toHaveLength(6);
    expect(new Set(fixture.conversations.map((item) => item.sourceKey)).size).toBe(6);
    expect(fixture.conversations[0].createdAt).toBe(Date.parse("2026-01-08T00:00:00Z"));
    expect(fixture.conversations.at(-1)?.createdAt).toBe(Date.parse("2026-08-01T00:00:00Z"));
  });

  test("source keys are synchronized with machine-readable expectations", async () => {
    const fixture = await loadFixture();
    const expected = await loadExpected();
    expect(fixture.conversations.map((item) => item.sourceKey)).toEqual(expected.sourceKeys);
  });

  test("contains the correction, closures, due date, and reuse evidence", async () => {
    const fixture = await loadFixture();
    const text = JSON.stringify(fixture).toLowerCase();
    for (const phrase of ["monthly is better than weekly", "bought the northstar domain", "issue zero is drafted", "august 20, 2026", "client briefing structure"]) expect(text).toContain(phrase);
  });
});
