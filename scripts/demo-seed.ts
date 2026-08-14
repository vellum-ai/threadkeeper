import { writeJson, FIXTURE_PATH, DEMO_WORKSPACE, STATE_PATH, assertDisposableWorkspace, assertDaemonWorkspace, loadFixture, parseJsonOutput, runCli } from "./demo-lib.ts";

assertDisposableWorkspace();
await assertDaemonWorkspace();
const fixture = await loadFixture();
const result = await runCli(["conversations", "import", "--file", FIXTURE_PATH, "--json"]);
const parsed = parseJsonOutput(result.stdout);
const listedResult = await runCli(["conversations", "list", "--include-archived"]);
const conversationIds: Record<string, string> = {};
const usedIds = new Set<string>();
for (const conversation of fixture.conversations) {
  const line = listedResult.stdout.split("\n").find((row) => row.includes(conversation.title) && !usedIds.has(row.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\s+/i)?.[1] ?? ""));
  const match = line?.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\s+/i);
  if (match) { conversationIds[conversation.sourceKey] = match[1]; usedIds.add(match[1]); }
}
if (Object.keys(conversationIds).length !== fixture.conversations.length) throw new Error(`Imported fixture, but could not map all conversation IDs from assistant output (${Object.keys(conversationIds).length}/${fixture.conversations.length})`);
await writeJson(STATE_PATH, { datasetId: fixture.datasetId, fixturePath: FIXTURE_PATH, workspace: DEMO_WORKSPACE, sourceKeys: fixture.conversations.map(({ sourceKey }) => sourceKey), conversationIds, importedAt: new Date().toISOString(), importResult: parsed });
console.log(JSON.stringify({ ok: true, datasetId: fixture.datasetId, imported: fixture.conversations.length, conversationIds, result: parsed }, null, 2));
