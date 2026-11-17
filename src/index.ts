import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executedCommands } from "./shell.ts";
import { ToolUseTracker } from "./batch.ts";
import { TimeTracker } from "./time.ts";
import { contentText, toolReminder } from "./notice.ts";

function recursiveSearch(args: Array<string | undefined>): boolean {
	let recursive = false;
	let pattern = false;
	let options = true;
	const files: Array<string | undefined> = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (options && arg === "--") { options = false; continue; }
		if (options && arg?.startsWith("--")) {
			const [option, inline] = arg.split(/=(.*)/su);
			if (option === "--recursive" || option === "--dereference-recursive") recursive = true;
			if (/^--(?:regexp|file|include|exclude|exclude-dir|exclude-from|label|context|after-context|before-context|max-count|directories|devices|binary-files)$/u.test(option)) {
				const value = inline ?? args[++index];
				if (option === "--regexp" || option === "--file") pattern = true;
				if (option === "--directories" && value === "recurse") recursive = true;
			}
			continue;
		}
		if (options && arg?.startsWith("-") && arg !== "-") {
			for (let at = 1; at < arg.length; at++) {
				const flag = arg[at];
				if (flag === "r" || flag === "R") recursive = true;
				if ("efABCmDd".includes(flag)) {
					const value = arg.slice(at + 1) || args[++index];
					if (flag === "e" || flag === "f") pattern = true;
					if (flag === "d" && value === "recurse") recursive = true;
					break;
				}
			}
			continue;
		}
		files.push(arg);
	}
	if (!pattern) files.shift();
	return recursive && (!files.length || files.some((file) => file === undefined || !/(?:^|\/)[^/]+\.\w+$/u.test(file)));
}

export default (pi: ExtensionAPI): void => {
	const tracker = new ToolUseTracker();
	const time = new TimeTracker();
	const started = new Map<string, number>();
	pi.on("before_agent_start", (event) => {
		// An extension message (e.g. a peer wake) starts no new user request.
		if (!("message" in event)) time.begin(event.prompt, Date.now());
		const { selectedTools, sections } = event.systemPromptOptions;
		if (selectedTools.includes("grep")) {
			sections.repository_search = `For repository source discovery, use the grep tool (gitignore-aware, bounded matches and long lines)${selectedTools.includes("symbol_search") ? ", or symbol_search for identifiers," : ""} instead of recursive Bash grep. Scope the known source directory rather than scanning build output, dependencies and Git metadata. Explicit inspection of generated or ignored files remains allowed: name the exact files and bound the output.`;
		} else delete sections.repository_search;
	});
	// Inspect local executions, not quoted ssh/wsl/fleet payloads or printed examples.
	// Explicitly named files remain allowed; --include is not a file target.
	// Scripted find-and-replace on source half-applies when one match misses (workflow-income 11-04).
	const scriptEdits = new Set<string>();
	pi.on("tool_call", (event) => {
		const command = event.toolName === "bash" ? String((event.input as { command?: unknown }).command ?? "") : "";
		if (/(?:readFileSync[\s\S]*\.replace\([\s\S]*writeFileSync|\b(?:sed|perl)\s+-\w*i)[\s\S]*\.(?:[cm]?[jt]sx?|py|rs|go|md)\b/u.test(command)) scriptEdits.add(event.toolCallId);
		const calls = executedCommands(command);
		// Without the grep tool there is nothing better to point to.
		if (pi.getActiveTools().includes("grep") && calls.some(({ name, args }) => basename(name) === "grep" && recursiveSearch(args))) return { block: true, reason: "Recursive Bash grep scans dependencies and build output and can run for minutes, so nothing in this command ran. Use the grep tool instead (path, glob, ignoreCase, context, literal); it skips gitignored files." };
	});
	// agent_end may still retry or continue; only settlement closes this request's clock.
	pi.on("agent_settled", () => time.end());
	pi.on("agent_start", () => {
		tracker.reset();
		started.clear();
	});
	// Models sometimes call an active tool by a mangled name (copy_bash, enlist_bash: ~200 calls); Pi answers only
	// "not found" and tool_search finds nothing loaded. Name the real tool in the result, once, before it is stored.
	const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const footer = (ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }) => { if (ctx.hasUI) ctx.ui.setStatus("efficient-tool-use", tracker.footer()); };
	pi.on("message_end", (event, ctx) => {
		const result = event.message.role === "toolResult" ? event.message : undefined;
		const missing = result && contentText(result.content).match(/^Tool (\S+) not found$/u)?.[1];
		const meant = missing && pi.getActiveTools().filter(tool => new RegExp(`(?:^|_)${escape(tool)}(?:_|$)`, "u").test(missing)).sort((a, b) => b.length - a.length)[0];
		if (result && meant) return { message: { ...result, content: [...result.content, { type: "text" as const, text: `Did you mean \`${meant}\`? It is active: call it by that exact name.` }] } };
		const batched = tracker.batchedAfter;
		tracker.observeBatch(event.message, performance.now());
		if (tracker.batchedAfter !== batched) footer(ctx);
		if (event.message.role === "assistant" && contentText(event.message.content).trim()) time.assistantText(Date.now());
		if (event.message.role === "user") time.userText(contentText(event.message.content));
	});
	pi.on("tool_execution_start", (event) => {
		started.set(event.toolCallId, performance.now());
		time.start(event.toolCallId, event.toolName, event.args && typeof event.args === "object" ? event.args : {}, Date.now());
	});
	const shape = (line: string) => line.replace(/\S*\/\S*|\d+/gu, "#");
	const sameShapeRuns = (text: string) => {
		if (!/\bFull output: \S+\]$/u.test(text)) return text;
		const out: string[] = [];
		let more = 0;
		const flush = () => { if (more) out.push(`(… ${more} more lines like this)`); more = 0; };
		for (const line of text.split("\n")) {
			const last = out.at(-1);
			if (last !== undefined && /\p{L}/u.test(shape(line)) && shape(line) === shape(last)) more++;
			else { flush(); out.push(line); }
		}
		flush();
		return out.join("\n");
	};
	pi.on("tool_result", (event, ctx) => {
		// Official bash only strips control bytes; undecodable binary (an image on stdout) stays as U+FFFD runs.
		// Collapse each run of such lines into one marker, keeping readable lines between runs (a code-page
		// error keeps its ASCII lines); the full output stays in its log.
		// Once Pi has truncated (the full log exists), a run of lines that differ only in paths or numbers
		// (rm on thousands of read-only files) is one line plus a count; a bare path list stays.
		let changed = false;
		// Official read decodes images only: a zip container (Word, PowerPoint, Excel, an archive) comes back as up to
		// 50 KB of raw bytes with an invitation to page on. One line naming the converters replaces it.
		const [first] = event.content;
		if (event.toolName === "read" && first?.type === "text" && first.text.startsWith("PK\u0003\u0004")) {
			const file = `'${String(event.input.path).replaceAll("'", "'\\''")}'`;
			changed = true;
			event = { ...event, content: [{ type: "text", text: `[Binary omitted: ${file} is a zip container (Word, PowerPoint, Excel or an archive). A Word file as text: pandoc ${file} -t plain --wrap=none; any of them: unzip -l ${file}.]` }] };
		}
		if (event.toolName === "bash") event = { ...event, content: event.content.map(block => {
			const collapsed = block.type === "text" && sameShapeRuns(block.text.replace(/^.*\uFFFD.*(?:\n.*\uFFFD.*)*/gmu, run => `[non-UTF-8 output omitted: ${run.length} characters; binary or text in another encoding (e.g. a Windows code page), not empty; view with iconv or xxd]`));
			if (!collapsed || collapsed === block.text) return block;
			changed = true;
			return { ...block, text: collapsed };
		}) };
		const start = started.get(event.toolCallId);
		started.delete(event.toolCallId);
		// The time notice is one plain paragraph appended to the result; it carries no instruction block.
		const timeNotice = time.complete(event.toolCallId, contentText(event.content), event.isError, Date.now());
		if (timeNotice && ctx.hasUI) ctx.ui.notify(timeNotice, "warning");
		const extra = [timeNotice, scriptEdits.delete(event.toolCallId) && "[Use the edit tool for source edits: it writes nothing unless every match is found.]"].filter(Boolean).map(text => ({ type: "text" as const, text: text as string }));
		if (start === undefined) return extra.length || changed ? { content: [...event.content, ...extra] } : undefined;
		const now = performance.now();
		const reminder = tracker.complete(event.toolName, now - start, now, contentText(event.content), pi.getActiveTools());
		if (!reminder) return extra.length || changed ? { content: [...event.content, ...extra] } : undefined;
		if (ctx.hasUI) ctx.ui.notify(reminder, "warning");
		footer(ctx);
		const result = toolReminder(event, "efficient-tool-use", "recent discovery tool batches", reminder);
		return { content: [...(result.content ?? event.content), ...extra] };
	});
};
