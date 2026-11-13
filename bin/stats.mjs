#!/usr/bin/env node
// Does the batch reminder work for you? Reads your own Pi session files (nothing leaves the machine) and finds every
// moment the reminder fires on: a third read-only lookup in a row sent alone. It then compares how often the model's
// next tool batch held several calls, before the package was installed and after, per model.
import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BATCH_REMINDER, DISCOVERY } from "../src/discovery.js";

const root = process.argv[2] ?? join(homedir(), ".pi/agent/sessions");
const files = readdirSync(root, { recursive: true }).filter(name => name.endsWith(".jsonl")).map(name => join(root, name));
const text = content => Array.isArray(content) ? content.map(part => part?.type === "text" ? part.text : "").join("\n") : "";

const events = []; // { model, startedAt, reminded, next, later: [parallel, total] }
let installedAt = Infinity;
for (const [index, file] of files.entries()) {
	if (index % 200 === 0) process.stderr.write(`[${index}/${files.length}] reading sessions\n`);
	const steps = [];
	// Stream: a long session file can exceed the largest string Node holds.
	for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line.includes('"type":"message"')) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const message = entry.message, at = Date.parse(entry.timestamp);
		if (message?.role === "toolResult") {
			const reminded = text(message.content).includes(BATCH_REMINDER);
			if (reminded) installedAt = Math.min(installedAt, at);
			steps.push({ kind: "result", reminded });
		} else if (message?.role === "assistant" && Array.isArray(message.content)) {
			const calls = message.content.filter(part => part?.type === "toolCall");
			steps.push(calls.length ? { kind: "batch", at, calls: calls.length, alone: calls.length === 1 && DISCOVERY.has(calls[0].name), model: message.model ?? "unknown" } : { kind: "text" });
		}
	}
	const startedAt = steps.find(step => step.kind === "batch")?.at;
	let run = 0;
	for (const [at, step] of steps.entries()) {
		if (step.kind === "text" || (step.kind === "batch" && !step.alone)) run = 0;
		if (step.kind !== "batch" || !step.alone || ++run < 3) continue;
		run = 0;
		const result = steps.slice(at + 1).find(next => next.kind === "result");
		const later = steps.slice(at + 1).filter(next => next.kind === "batch").slice(0, 5);
		if (!result || !later.length) continue;
		events.push({ model: step.model, startedAt, reminded: result.reminded, next: later[0].calls > 1, later: [later.filter(next => next.calls > 1).length, later.length] });
	}
}

const groups = new Map();
for (const event of events) {
	const group = event.startedAt < installedAt ? "before install" : event.reminded ? "after, reminded" : "after, not reminded";
	const key = `${event.model}\t${group}`;
	const totals = groups.get(key) ?? { n: 0, next: 0, laterParallel: 0, later: 0 };
	totals.n++; totals.next += event.next; totals.laterParallel += event.later[0]; totals.later += event.later[1];
	groups.set(key, totals);
}
const percent = value => `${(100 * value).toFixed(0)}%`;
const rows = [...groups].filter(([, totals]) => totals.n >= 30).sort(([a], [b]) => a.localeCompare(b)).map(([key, t]) => {
	const [model, group] = key.split("\t"), p = t.next / t.n, margin = 1.96 * Math.sqrt(p * (1 - p) / t.n);
	return { model, group, moments: t.n, "next batch had several calls": `${percent(p)} (95% CI ${percent(Math.max(0, p - margin))}-${percent(p + margin)})`, "next 5 batches": percent(t.laterParallel / t.later) };
});
console.log(`${files.length} sessions, ${events.length} moments with three lookups in a row sent alone.`);
console.log(installedAt === Infinity ? "No batch reminder found: the package has not run in these sessions yet." : `First reminder: ${new Date(installedAt).toISOString().slice(0, 10)}.`);
if (rows.length) console.table(rows);
else console.log("Too few moments (at least 30 per model and group) to compare yet.");
console.log("\"after, not reminded\" moments are mostly lookups that depended on each other, so compare reminded moments with \"before install\".");
