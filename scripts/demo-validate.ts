import { assertFixture, loadExpected, loadFixture } from "./demo-lib.ts";

const fixture = await loadFixture();
const expected = await loadExpected();
assertFixture(fixture);
const expectedKeys = Array.isArray(expected.sourceKeys) ? expected.sourceKeys : [];
const actualKeys = fixture.conversations.map(({ sourceKey }) => sourceKey);
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("Fixture sourceKeys do not match expected-results.json in stable order");
const required = ["Northstar", "weekly", "monthly", "landing page", "issue zero", "client briefing"];
const transcript = JSON.stringify(fixture).toLowerCase();
for (const concept of required) if (!transcript.includes(concept.toLowerCase())) throw new Error(`Fixture is missing required concept: ${concept}`);
if (fixture.conversations.length !== 6) throw new Error("Expected exactly six fixture conversations");
console.log(JSON.stringify({ ok: true, datasetId: fixture.datasetId, conversations: fixture.conversations.length, sourceKeys: actualKeys }, null, 2));
