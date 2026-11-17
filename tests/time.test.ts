import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize, formatDuration, jobStates, THRESHOLDS_MS, TimeTracker } from "../src/time.ts";
import extension from "../src/index.ts";

test("commands are categorized by what they wait on, verify, or change", () => {
	assert.equal(categorize("bash", { command: "sleep 1800; jobs.sh --text" }), "wait");
	assert.equal(categorize("bash", { command: "sha256sum -c receipts.sha256" }), "verify");
	assert.equal(categorize("bash", { command: "python -m pytest tests/" }), "other");
	assert.equal(categorize("bash", { command: "python -m pytest experiments/x/tests/test_readiness.py -q" }), "other", "running the test suite is work, not verification");
	assert.equal(categorize("bash", { command: "node --test packages/x/tests/validation.test.ts" }), "other");
	assert.equal(categorize("bash", { command: "python validate.py --dataset D --no-cache" }), "verify");
	assert.equal(categorize("bash", { command: "node --test tests/a.test.mjs && sha256sum -c manifest.sha256" }), "verify", "a hash check alongside tests still counts");
	assert.equal(categorize("bash", { command: "shasum -a 256 -c after.sha256" }), "verify");
	assert.equal(categorize("bash", { command: "slurm-profile --stage full-input-validation readiness inputs" }), "verify");
	assert.equal(categorize("bash", { command: "git diff --check -- README.md" }), "verify");
	assert.equal(categorize("bash", { command: "python - <<'PY'\nprint('broken relative links', len(bad))\nPY" }), "verify");
	assert.equal(categorize("bash", { command: "python - <<'PY'\nprint('markdown structural findings', len(bad))\nPY" }), "verify");
	assert.equal(categorize("bash", { command: "python - <<'PY'\nprint('duplicate paragraphs', len(dups))\nPY" }), "verify");
	assert.equal(categorize("server_cam", { command: "submit", scripts: ["a.sh"] }), "approval");
	assert.equal(categorize("server_cam", { command: "status" }), "wait");
	assert.equal(categorize("edit", { path: "x.py" }), "edit");
	assert.equal(categorize("read", { path: "x.py" }), "inspect");
	assert.equal(formatDuration(65 * 60_000), "1h05m"); assert.equal(formatDuration(7 * 60_000), "7m");
});

test("one notice per threshold, facts only, never before fifteen minutes", () => {
	const t = new TimeTracker();
	const m = (n: number) => n * 60_000;
	t.begin("  you carry on   do all these until you need me ", 0);
	t.start("a", "bash", { command: "sha256sum big.bin" }, m(1));
	assert.equal(t.complete("a", "ok", false, m(14)), undefined, "under 15 minutes says nothing");
	t.start("b", "bash", { command: "jobs.sh --text" }, m(14));
	const first = t.complete("b", "35801189 RUNNING 00:10", false, m(16))!;
	assert.match(first, /^\[time notice\] This request has run for 16m: verification, hashing or preflight 13m · waiting on jobs or status polls 2m\. /u);
	assert.match(first, /Your last message to the user was 16m ago\. /u);
	assert.match(first, /Since the request began: 0 edit\/write tool calls \(shell writes not counted\) · 0 job state changes · 1 hash\/preflight checks · 1 status polls · 0 tool errors\. /u);
	assert.match(first, /The latest message: "you carry on do all these until you need me"\. /u);
	assert.match(first, /Real time is passing and the user is waiting\. If a more direct way reaches the same goal faster, take it; the goal itself does not change\.$/u);
	assert.ok(!first.includes("\n"), "one paragraph");
	t.start("c", "bash", { command: "jobs.sh --text" }, m(17));
	assert.equal(t.complete("c", "35801189 RUNNING 00:11", false, m(18)), undefined, "the 15m threshold fires once");
	t.assistantText(m(20));
	t.start("d", "edit", { path: "x.py" }, m(21)); t.complete("d", "ok", false, m(22));
	t.start("e", "bash", { command: "sleep 1800" }, m(22));
	t.start("f", "bash", { command: "jobs.sh" }, m(52)); t.complete("f", "35801189 RUNNING", false, m(53));
	t.start("g", "bash", { command: "jobs.sh" }, m(53));
	const third = t.complete("g", "35801189 COMPLETED 0:0", false, m(61))!;
	assert.match(third, /run for 1h01m/u);
	assert.match(third, /last message to the user was 41m ago/u);
	assert.match(third, /1 edit\/write tool calls \(shell writes not counted\) · 1 job state changes · 1 hash\/preflight checks · 4 status polls · 0 tool errors\./u);
	assert.ok(!third.includes("(2 consecutive"), "consecutive-poll note needs three");
	assert.equal(t.complete("e", "", false, m(62)), undefined, "a sleep that spans 30m and 60m fires those thresholds together, once");
	t.begin("next request", m(70));
	t.start("h", "bash", { command: "sleep 10" }, m(70));
	assert.equal(t.complete("h", "", false, m(80)), undefined, "a new user request resets everything");
	assert.equal(THRESHOLDS_MS.length, 6);
});

test("the notice quotes the latest steer, cut at a word boundary", () => {
	const t = new TimeTracker();
	t.begin(`${"word ".repeat(23)}and we uh plan`, 0);
	t.start("a", "bash", { command: "true" }, 0);
	assert.match(t.complete("a", "", false, 16 * 60_000)!, /"(word ){23}and\u2026"\./u, "never mid-word");
	t.userText("aim for at least 90% accuracy");
	t.start("b", "bash", { command: "true" }, 0);
	assert.match(t.complete("b", "", false, 31 * 60_000)!, /latest message: "aim for at least 90% accuracy"/u);
});

test("job states are read from Outbox tickets, jobs.sh JSON, Slurm rows and bare squeue answers", () => {
	const ticket = (status: string, receipt: object | null) => JSON.stringify({ counts: { submitted: 287 }, status_filter: { batch: "b", ticket: null },
		jobs: [{ job_name: "exp07a", receipt, status, ticket_id: "b-0" }] });
	assert.deepEqual(jobStates(ticket("queued", null), "status"), ["b-0:queued"]);
	assert.deepEqual(jobStates(ticket("submitted", { job_id: "36242733", status: "submitted" }), "status"), ["b-0:submitted"], "the receipt is the same job");
	assert.deepEqual(jobStates(JSON.stringify({ active: [{ job_id: "36278660_8", state: "RUNNING" }] }), "jobs.sh --json"), ["36278660_8:RUNNING"]);
	assert.deepEqual(jobStates("36278660_8\tRUNNING\t1:43\n36280038 FAILED", "jobs.sh --text"), ["36278660_8:RUNNING", "36280038:FAILED"]);
	assert.deepEqual(jobStates("RUNNING 4:32 gpu-q-11\nwarnings.warn(", "cd x && squeue -j 36242733 -h -o '%T %M %R'"), ["36242733:RUNNING"]);
	assert.deepEqual(jobStates("38651098_0|exp|RUNNING|0:10\n38651098_1|exp|CANCELLED+|0:00", "query"), ["38651098_0:RUNNING", "38651098_1:CANCELLED"], "sacct pipe rows own their states");
	assert.deepEqual(jobStates("TIMEOUT\nCANCELLED", "node -e 'f(10700));' status"), [], "a number inside code is not a job");

	const t = new TimeTracker();
	const m = (n: number) => n * 60_000;
	t.begin("So sleep for an appropriate time and wake up and check again.", 0);
	t.start("a", "server_cam", { command: "status" }, m(1)); t.complete("a", ticket("queued", null), false, m(1));
	t.start("b", "server_cam", { command: "status" }, m(5)); t.complete("b", ticket("submitted", { job_id: "36242733", status: "submitted" }), false, m(5));
	t.start("c", "server_cam", { command: "run", remoteCommand: "squeue -j 36242733 -h -o '%T'" }, m(9)); t.complete("c", "PENDING", false, m(9));
	t.start("d", "server_cam", { command: "run", remoteCommand: "squeue -j 36242733 -h -o '%T'" }, m(12)); t.complete("d", "RUNNING", false, m(12));
	t.start("e", "read", { path: "job.sh" }, m(13)); t.complete("e", "36999999 COMPLETED", false, m(13));
	t.start("f", "server_cam", { command: "run", remoteCommand: "squeue -j 36242733 -h -o '%T'" }, m(15));
	assert.match(t.complete("f", "RUNNING", false, m(16))!, /· 2 job state changes · 0 hash\/preflight checks · 5 status polls ·/u, "first sightings are baselines; file contents are not status answers");
});

test("time the user spends in an approval dialog does not trigger a notice", () => {
	// Incident (00-meeting-teach-me): a 1h32m launch_peers approval was reported as the model's delay.
	const t = new TimeTracker(), m = (n: number) => n * 60_000;
	t.begin("launch the sessions", 0);
	t.start("a", "launch_peers", { peers: [] }, m(0)); assert.equal(t.complete("a", "launched", false, m(92)), undefined);
	t.start("b", "read", { path: "x" }, m(92)); assert.equal(t.complete("b", "ok", false, m(93)), undefined);
});

test("a single long wait that crosses several thresholds yields one notice stating the latest total", () => {
	const t = new TimeTracker();
	const m = (n: number) => n * 60_000;
	t.begin("wait for the job", 0);
	t.start("a", "bash", { command: "sleep 3600; jobs.sh" }, m(0));
	const only = t.complete("a", "35801189 PENDING", false, m(61))!;
	assert.match(only, /^\[time notice\] This request has run for 1h01m: waiting on jobs or status polls 1h01m\./u);
	assert.match(only, /0 job state changes · 0 hash\/preflight checks · 1 status polls/u);
	t.start("b", "bash", { command: "jobs.sh" }, m(61));
	assert.equal(t.complete("b", "35801189 PENDING", false, m(62)), undefined, "15m, 30m and 1h were all consumed by the one notice");
});

test("settlement ends request timing; retries retain it, peer wakes stay quiet and new requests restart it", t => {
	const hooks = new Map<string, Function>();
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => ["read", "bash"] } as never);
	const notices: string[] = [];
	const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	const at = (minutes: number) => { clock = minutes * 60_000; };
	const emit = (name: string, event = {}) => hooks.get(name)?.(
		name === "before_agent_start" ? { ...event, systemPromptOptions: { selectedTools: ["bash", "grep"], sections: {} } } : event, ctx);
	const start = (id: string, toolName = "bash") => emit("tool_execution_start", { toolCallId: id, toolName, args: {} });
	const result = (id: string, toolName = "bash") => emit("tool_result", {
		toolCallId: id, toolName, isError: false, content: [{ type: "text", text: "original result" }],
	});

	emit("before_agent_start", { prompt: "old request" });
	emit("agent_start");
	at(8);
	emit("turn_end");
	emit("agent_end", { willRetry: true });
	emit("agent_start");
	start("retry");
	at(16);
	assert.match(result("retry").content[1].text, /This request has run for 16m/u, "an intermediate end must not reset the original clock");

	at(21);
	emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Draft ready; please confirm." }] } });
	emit("agent_end", { willRetry: false });
	emit("agent_settled");
	at(45);
	// An idle peer-completion wake starts a custom run (Pi 1.2.0+ emits before_agent_start without a prompt).
	emit("before_agent_start", { messageType: "custom", message: { role: "custom", customType: "peer-completion", content: "Peer finished." } });
	emit("agent_start");
	emit("message_end", { message: { role: "custom", customType: "peer-completion", content: "Peer finished." } });
	start("peer", "read_peer");
	assert.equal(result("peer", "read_peer"), undefined, "no stale time notice in the peer tool result");
	assert.equal(notices.length, 1, "no stale terminal warning either");
	emit("agent_settled");

	at(46);
	emit("before_agent_start", { prompt: "new request" });
	emit("agent_start");
	start("new");
	at(51);
	assert.equal(result("new"), undefined, "the fresh request is only five minutes old");
	start("later");
	at(62);
	const next = result("later").content[1].text;
	assert.match(next, /This request has run for 16m/u);
	assert.match(next, /latest message: "new request"/u);
	assert.doesNotMatch(next, /old request/u);
	assert.equal(notices.length, 2);
});

test("the extension appends the notice to the tool result and shows it as a warning card, without touching other results", () => {
	const hooks = new Map<string, Function>();
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => ["read", "bash"] } as never);
	const notices: Array<[string, string?]> = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level?: string) => notices.push([message, level]) } };
	const realNow = Date.now; let clock = 1_000_000;
	Date.now = () => clock;
	try {
		hooks.get("before_agent_start")!({ prompt: "carry on", systemPromptOptions: { selectedTools: ["bash", "grep"], sections: {} } }, ctx);
		hooks.get("message_end")!({ message: { role: "user", content: [{ type: "text", text: "latest" }, { type: "image", text: "private" }, { type: "text", text: 42 }, { type: "text", text: "request" }] } });
		hooks.get("agent_start")!({}, ctx);
		hooks.get("tool_execution_start")!({ toolCallId: "1", toolName: "bash", args: { command: "sha256sum x" } }, ctx);
		clock += 5 * 60_000;
		const quiet = hooks.get("tool_result")!({ toolName: "bash", toolCallId: "1", input: {}, isError: false, content: [{ type: "text", text: "r1" }] }, ctx);
		assert.equal(quiet, undefined);
		hooks.get("tool_execution_start")!({ toolCallId: "2", toolName: "bash", args: { command: "sleep 900" } }, ctx);
		clock += 16 * 60_000;
		const result = hooks.get("tool_result")!({ toolName: "bash", toolCallId: "2", input: {}, isError: false, content: [{ type: "text", text: "r2" }] }, ctx);
		assert.equal(result.content[0].text, "r2");
		assert.match(result.content[1].text, /^\[time notice\] This request has run for 21m/u);
		assert.match(result.content[1].text, /latest message: "latest request"/u);
		assert.equal(result.content.length, 2);
		assert.deepEqual(notices.at(-1)?.[1], "warning");
		assert.equal(notices.at(-1)?.[0], result.content[1].text);
	} finally { Date.now = realNow; }
});

test("binary bytes in a bash result collapse to one marker, keeping the text around them", () => {
	const hooks = new Map<string, Function>();
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => ["read", "bash"] } as never);
	const binary = "start\n\uFFFDPNG\uFFFD\nIHDR\n\uFFFD\uFFFDx\nmagick: unable to open image 'L.png'\nfull output: /tmp/log";
	const result = (toolName: string) => hooks.get("tool_result")!({ toolName, toolCallId: "1", input: {}, isError: false, content: [{ type: "text", text: binary }] }, { hasUI: false });
	const marker = (n: number) => `[non-UTF-8 output omitted: ${n} characters; binary or text in another encoding (e.g. a Windows code page), not empty; view with iconv or xxd]`;
	assert.equal(result("bash").content[0].text, `start\n${marker(5)}\nIHDR\n${marker(3)}\nmagick: unable to open image 'L.png'\nfull output: /tmp/log`);
	// A GBK PowerShell error keeps its readable English lines between the undecodable ones.
	const gbk = "\uFFFD\uFFFD\uFFFD\uFFFD C:\\x.ps1\uFFFD\uFFFD\r\n    + CategoryInfo : SecurityError\r\n    + FullyQualifiedErrorId : UnauthorizedAccess";
	const kept = hooks.get("tool_result")!({ toolName: "bash", toolCallId: "2", input: {}, isError: true, content: [{ type: "text", text: gbk }] }, { hasUI: false }).content[0].text;
	assert.match(kept, /CategoryInfo : SecurityError[^]*UnauthorizedAccess/u);
	assert.equal(result("read"), undefined);
});
