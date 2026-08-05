import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const eventId = "main:agent#00000000000123#bld:ZDP4ZE3D";
const transportSource = readFileSync("extension/fix-error-transport.js", "utf8");
const calls = [];
const window = {
  __lvblFetch(url, options) {
    calls.push({ url, options });
    return Promise.resolve({ ok: true });
  },
};

vm.runInNewContext(transportSource, { window, URL, JSON });

await window.__lvblFetch("https://api.lovable.dev/projects/project-1/chat", {
  method: "POST",
  body: JSON.stringify({
    message: "teste",
    chat_only: true,
    intent: "chat",
    contains_error: false,
    error_ids: [],
  }),
});

assert.equal(calls.length, 1);
const payload = JSON.parse(calls[0].options.body);
assert.equal(payload.chat_only, false);
assert.equal(payload.intent, "fix_error");
assert.equal(payload.contains_error, true);
assert.deepEqual(payload.error_ids, [eventId]);
assert.deepEqual(payload.message_intent_metadata, {
  fix_error_metadata: {
    errors: [{
      error_type: "build",
      error_message: "",
      build_event_id: eventId,
    }],
  },
});

const popupSource = readFileSync("extension/popup.js", "utf8");
const standardChatSource = readFileSync("extension/content-standard-chat.js", "utf8");
const pagePatchSource = readFileSync("extension/page-fetch-patch.js", "utf8");

assert.doesNotMatch(popupSource, /messageBody\.intent\s*=\s*undefined/);
assert.match(standardChatSource, /intent:\s*['"]fix_error['"]/);
assert.match(pagePatchSource, /obj\.intent\s*=\s*['"]fix_error['"]/);
assert.match(pagePatchSource, /obj\.chat_only\s*=\s*false/);

console.log("[extension] todos os caminhos de chat preservam fix_error");
