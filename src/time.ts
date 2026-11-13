/**
 * Wall-clock awareness for one user request. Counts where the elapsed time went and what
 * changed, then states it once per threshold. It judges nothing; the model in the loop does.
 */
export type Category = "wait" | "approval" | "verify" | "edit" | "inspect" | "other";
export const THRESHOLDS_MS = [15, 30, 60, 120, 240, 480].map(minutes => minutes * 60_000);
const LABEL: Record<Category, string> = {
	wait: "waiting on jobs or status polls", approval: "waiting for the user's approval", verify: "verification, hashing or preflight",
	edit: "edits and writes", inspect: "reading and searching", other: "other commands",
};
const SLURM_STATE = /^(?:RUNNING|COMPLETED|FAILED|TIMEOUT|CANCELLED|PENDING|OUT_OF_MEMORY)(?=\+?$)/u;
const JOB_ID = /^\d{5,}(?:_(?:\d+|\[[^\]]*\]))?(?:\.\w+)?$/u;

/**
 * The `job:state` pairs a status answer reports. JSON records that name a job (`job_id` or Outbox
 * `ticket_id`) and its `state` or `status` are one observation each; their nested records describe the
 * same job. Plain text is read as Slurm state words in whitespace- or `|`-separated rows, owned by the
 * nearest earlier job id on their row or else by the job the command asked about; unowned states are skipped.
 */
export function jobStates(result: string, command: string): string[] {
	const found: string[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(visit);
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const id = record.ticket_id ?? record.job_id, state = record.state ?? record.status;
		if ((typeof id === "string" || typeof id === "number") && typeof state === "string") found.push(`${id}:${state}`);
		else Object.values(record).forEach(visit);
	};
	try { visit(JSON.parse(result)); return found; } catch { /* plain text */ }
	const asked = command.split(/[\s'"]+/u).find(token => JOB_ID.test(token));
	for (const line of result.split("\n")) {
		let owner = asked;
		for (const token of line.split(/[\s|]+/u))
			if (JOB_ID.test(token)) owner = token;
			else if (owner && SLURM_STATE.test(token)) found.push(`${owner}:${token.replace(/\+$/u, "")}`);
	}
	return found;
}
const commandText = (input: Record<string, unknown>): string =>
	[input.command, input.remoteCommand].filter(part => typeof part === "string").join("\n");

export function categorize(toolName: string, input: Record<string, unknown>): Category {
	const command = typeof input.command === "string" ? input.command : "";
	if (toolName === "server_cam") return command === "submit" ? "approval" : "wait";
	if (toolName === "launch_peers") return "approval"; // the user decides in a native dialog
	if (/^(?:edit|write)$/u.test(toolName)) return "edit";
	if (/^(?:read|grep|find|ls|read_symbol|read_enclosing|module_report|symbol_search|lens_diagnostics|project_report)$/u.test(toolName)) return "inspect";
	// Test suites are ordinary work, unless the command also checks hashes; explicit result checks are verification.
	if (/\b(?:pytest|node --test|unittest|vitest|jest)\b|\btests?\//iu.test(command)) return /sha-?\d|shasum|checksum/iu.test(command) ? "verify" : "other";
	if (/sha256|sha-?sum|shasum|\bhash(?:ing|es)?\b|\bidentity\b|provenance|readiness|preflight|checksum|digest|\bverify\b|--verify|\bvalidate\b|validate\.py|input-check|input-valid|\bgit\s+diff\b[^\n]*--check\b|\bbroken (?:relative )?links?\b|\bmarkdown structural\b|\bduplicate paragraphs?\b/iu.test(command)) return "verify";
	if (/^\s*sleep\b|jobs\.sh|\bsacct\b|\bsqueue\b|--max-age|job-outcome|\bstatus\b/iu.test(command)) return "wait";
	return "other";
}

export const formatDuration = (ms: number): string => {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
};

export class TimeTracker {
	private active = false;
	private startedAt = 0;
	private userWords = "";
	private lastAssistantTextAt = 0;
	private spent: Partial<Record<Category, number>> = {};
	private counts = { writes: 0, jobStateChanges: 0, verifications: 0, polls: 0, errors: 0 };
	private lastJobState = new Map<string, string>();
	private open = new Map<string, { category: Category; command: string; startedAt: number }>();
	private fired = new Set<number>();
	private consecutivePolls = 0;

	begin(prompt: string, now: number): void {
		this.active = true; this.startedAt = now; this.lastAssistantTextAt = now;
		this.userText(prompt);
		this.spent = {}; this.counts = { writes: 0, jobStateChanges: 0, verifications: 0, polls: 0, errors: 0 };
		this.lastJobState.clear(); this.open.clear(); this.fired.clear(); this.consecutivePolls = 0;
	}
	end(): void { this.active = false; this.open.clear(); }
	assistantText(now: number): void { this.lastAssistantTextAt = now; }
	/** The latest user message in this request, including a steer; cut at a word boundary. */
	userText(text: string): void {
		const words = text.replace(/\s+/gu, " ").trim();
		if (!words) return;
		this.userWords = words.length <= 120 ? words : `${words.slice(0, 121).replace(/\s+\S*$/u, "")}…`;
	}
	start(toolCallId: string, toolName: string, input: Record<string, unknown>, now: number): void {
		this.open.set(toolCallId, { category: categorize(toolName, input), command: commandText(input), startedAt: now });
	}
	/** Returns the notice to deliver, or undefined. At most one notice per threshold per request. */
	complete(toolCallId: string, resultText: string, isError: boolean, now: number): string | undefined {
		const call = this.open.get(toolCallId); this.open.delete(toolCallId);
		if (!this.active) return;
		if (call) {
			this.spent[call.category] = (this.spent[call.category] ?? 0) + Math.max(0, now - call.startedAt);
			if (isError) this.counts.errors++;
			if (call.category === "edit" && !isError) this.counts.writes++;
			if (call.category === "verify") this.counts.verifications++;
			if (call.category === "wait") {
				this.counts.polls++; this.consecutivePolls++;
				// A job's first observation is its baseline; only a later different state is a change.
				for (const key of jobStates(resultText, call.command)) {
					const cut = key.lastIndexOf(":"), id = key.slice(0, cut), state = key.slice(cut + 1), last = this.lastJobState.get(id);
					if (last !== undefined && last !== state) this.counts.jobStateChanges++;
					this.lastJobState.set(id, state);
				}
			} else this.consecutivePolls = 0;
		}
		const elapsed = now - this.startedAt;
		// The user's own decision time in an approval dialog is not time the model spent.
		const due = THRESHOLDS_MS.filter(limit => elapsed - (this.spent.approval ?? 0) >= limit && !this.fired.has(limit));
		if (!due.length) return;
		for (const limit of due) this.fired.add(limit);
		return this.notice(elapsed, now);
	}
	private notice(elapsed: number, now: number): string {
		const parts = (Object.entries(this.spent) as [Category, number][]).filter(([, ms]) => ms >= 30_000)
			.sort((a, b) => b[1] - a[1]).map(([category, ms]) => `${LABEL[category]} ${formatDuration(ms)}`);
		const c = this.counts;
		const polls = this.consecutivePolls >= 3 ? ` (${this.consecutivePolls} consecutive polls with no other action)` : "";
		const words = this.userWords ? ` The latest message: "${this.userWords}".` : "";
		return `[time notice] This request has run for ${formatDuration(elapsed)}${parts.length ? `: ${parts.join(" · ")}` : ""}. ` +
			`Your last message to the user was ${formatDuration(now - this.lastAssistantTextAt)} ago. ` +
			`Since the request began: ${c.writes} edit/write tool calls (shell writes not counted) · ${c.jobStateChanges} job state changes · ${c.verifications} hash/preflight checks · ${c.polls} status polls · ${c.errors} tool errors${polls}.${words} ` +
			`Real time is passing and the user is waiting. If a more direct way reaches the same goal faster, take it; the goal itself does not change.`;
	}
}
