import assert from "node:assert/strict";
import { ToolUseTracker } from "../src/batch.ts";

const tracker = new ToolUseTracker();
const batch = (name: string, now: number) =>
	tracker.observeBatch(
		{ role: "assistant", content: [{ type: "toolCall", name }] },
		now,
	);
batch("read", 0);
assert.equal(tracker.complete("read", 100, 100), undefined);
batch("grep", 3_000);
assert.equal(tracker.complete("grep", 100, 3_100), undefined);
batch("lsp_diagnostics", 6_000);
const reminder = tracker.complete("lsp_diagnostics", 100, 6_100) ?? "";
assert.match(reminder, /6\.1s wall-clock/);
assert.match(reminder, /0\.3s cumulative tool runtime/);
assert.match(reminder, /at most 3 independent, bounded discovery calls/);
assert.match(reminder, /never batch unbounded full-file reads/);
assert.match(reminder, /does not imply cpu multithreading/);
tracker.observeBatch({
	role: "assistant",
	content: [
		{ type: "toolCall", name: "read" },
		{ type: "toolCall", name: "grep" },
	],
});
assert.equal(tracker.complete("read", 5_000), undefined);
assert.equal(tracker.footer(), "⚒ 1/1 batched", "the batch after the reminder held two calls");
tracker.reset();
assert.equal(tracker.footer(), "⚒ 1/1 batched", "a new run keeps the session totals");
assert.equal(new ToolUseTracker().footer(), undefined, "nothing shows before the first reminder");
// Incident (workflow-emails 10-29): each call used the previous result, so they could not have been batched.
const chain = new ToolUseTracker();
const step = (name: string, args: object, at: number, result: string) => (chain.observeBatch({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] }, at), chain.complete(name, 100, at + 100, result));
step("read", { path: "/tmp/shot.png" }, 0, "Open in PowerPoint");
step("grep", { pattern: "Open in PowerPoint" }, 3_000, "src/pptx-opening.tsx:42: Open in PowerPoint");
assert.equal(step("read", { path: "/repo/src/pptx-opening.tsx", offset: 40 }, 6_000, ""), undefined, "dependent calls are not told to batch");
// An ignored reminder repeats on each next lone lookup, three times, then stays quiet until the next user message.
const stubborn = new ToolUseTracker();
const lone = (at: number, name = "read") => (stubborn.observeBatch({ role: "assistant", content: [{ type: "toolCall", name, arguments: { path: `/f${at}.txt` } }] }, at), stubborn.complete(name, 100, at + 100, ""));
const said = Array.from({ length: 9 }, (_, index) => lone(index * 3_000));
assert.deepEqual(said.map(text => text?.match(/singleton|again \(\d/u)?.[0]), [undefined, undefined, "singleton", "again (1", "again (2", "again (3", undefined, undefined, undefined]);
assert.match(said[5] ?? "", /quiet until the next user message/u);
assert.equal(stubborn.footer(), "⚒ 0/1 batched");
stubborn.reset();
assert.deepEqual([lone(30_000), lone(33_000), lone(36_000)].map(Boolean), [false, false, true], "a new user message starts over");
stubborn.observeBatch({ role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "grep" }] });
assert.equal(stubborn.footer(), "⚒ 1/2 batched", "a batch ends the repeats and counts");
assert.equal(lone(40_000), undefined, "no repeat after a batch");

// The reminder names structured readers only when the session has them.
const remind = (active: string[]) => {
	const t = new ToolUseTracker();
	const lone = (name: string, at: number) => (t.observeBatch({ role: "assistant", content: [{ type: "toolCall", name }] }, at), t.complete(name, 100, at + 100, "", active));
	lone("read", 0);
	lone("grep", 3_000);
	return lone("read", 6_000) ?? "";
};
assert.match(remind(["read", "grep", "bash"]), /prefer reads with explicit limits;/);
assert.doesNotMatch(remind(["read", "grep", "bash"]), /module_report|read_symbol/);
assert.match(remind(["read", "module_report", "read_symbol"]), /prefer module_report, read_symbol, reads with explicit limits;/);
assert.match(remind(["read", "read_symbol"]), /prefer read_symbol, reads with explicit limits;/);
