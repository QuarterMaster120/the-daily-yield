import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { unsubscribeLink, subscriberId, syncUnsubscribes } from "./unsubscribe-client.mjs";
const config = {url:"https://example.com",tokenKey:"test-secret",statusKey:"test-status"};
test("tokens conceal addresses and normalize identity", () => {
  assert.equal(unsubscribeLink(" USER@example.com ",config),unsubscribeLink("user@example.com",config));
  assert.match(unsubscribeLink("user@example.com",config),/token=[a-f0-9]{64}\.[a-f0-9]{64}$/);
  assert.ok(!unsubscribeLink("user@example.com",config).includes("user"));
});
test("sync deletes only confirmed opt-outs from persistent subscriber storage", async () => {
  const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE subscribers(email TEXT PRIMARY KEY); INSERT INTO subscribers VALUES ('one@example.com'),('two@example.com')");
  const removed=await syncUnsubscribes(db,{config,fetch:async()=>new Response(JSON.stringify({unsubscribed:[subscriberId("one@example.com",config)]}))});
  assert.equal(removed,1); assert.deepEqual(db.prepare("SELECT email FROM subscribers").all().map(r=>r.email),["two@example.com"]); db.close();
});
test("network/status failure aborts rather than silently retaining permission to send", async () => {
  const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE subscribers(email TEXT); INSERT INTO subscribers VALUES ('one@example.com')");
  await assert.rejects(syncUnsubscribes(db,{config,fetch:async()=>new Response("",{status:503})}),/Delivery stopped/);
  assert.equal(db.prepare("SELECT count(*) n FROM subscribers").get().n,1); db.close();
});
