import test from "node:test";
import assert from "node:assert/strict";
import { sendResend, RESEND_SENDER } from "./resend-mail.mjs";

test("uses the requested sender and preserves recipient and content", async () => {
  const id = await sendResend("recipient@example.com", { subject: "Rates", html: "<p>Rates</p>", text: "Rates" }, {
    apiKey: "test-only",
    fetch: async (url, request) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.deepEqual(JSON.parse(request.body), { from: RESEND_SENDER, to: ["recipient@example.com"], subject: "Rates", html: "<p>Rates</p>", text: "Rates" });
      return new Response(JSON.stringify({ id: "accepted" }), { status: 200 });
    },
  });
  assert.equal(id, "accepted");
});

test("authentication and throttling failures cannot report success", async () => {
  for (const status of [401, 429]) {
    await assert.rejects(sendResend("recipient@example.com", { subject: "Rates" }, { apiKey: "test-only", fetch: async () => new Response("{}", { status }) }), new RegExp(`status ${status}`));
  }
});
