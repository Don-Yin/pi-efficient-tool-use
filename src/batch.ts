import { BATCH_REMINDER, DISCOVERY as discovery } from "./discovery.js";

interface Timing {
	name: string;
	milliseconds: number;
	startedAt: number;
}

interface SingletonBatch {
	name: string;
	startedAt: number;
}

export class ToolUseTracker {
	private streak: Timing[] = [];
	private singleton: SingletonBatch | undefined;
	/** The previous discovery result: a call that uses a value from it depended on it and could not be batched (workflow-emails 10-29). */
	private lastResult = "";
	/** Session totals for the footer: reminders sent, and how many were followed by a batch of several calls. */
	reminders = 0;
	batchedAfter = 0;
	private awaitingNext = false;

	/** `⚒ 2/3 batched`: of 3 reminders, 2 were followed by a batch of several calls; undefined until the first reminder. */
	footer(): string | undefined {
		return this.reminders ? `⚒ ${this.batchedAfter}/${this.reminders} batched` : undefined;
	}

	reset(): void {
		this.streak = [];
		this.singleton = undefined;
	}

	observeBatch(
		message: { role?: string; content?: unknown },
		now = performance.now(),
	): void {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		const tools = message.content.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const value = block as {
				type?: string;
				name?: string;
				toolName?: string;
			};
			return value.type === "toolCall"
				? [value.name ?? value.toolName ?? "unknown"]
				: [];
		});
		// The same measure as src/stats.mjs: did the next tool batch after a reminder hold several calls?
		if (this.awaitingNext && tools.length) {
			if (tools.length > 1) this.batchedAfter++;
			this.awaitingNext = false;
		}
		const args = message.content.flatMap(block => Object.values((block as { arguments?: object })?.arguments ?? {}));
		if (args.some(arg => typeof arg === "string" && arg.length > 2 && this.lastResult.includes(arg.split("/").pop()!))) this.streak = [];
		this.singleton =
			tools.length === 1 && discovery.has(tools[0])
				? { name: tools[0], startedAt: now }
				: undefined;
		if (!this.singleton && tools.length) this.streak = [];
	}

	complete(
		name: string,
		milliseconds: number,
		now = performance.now(),
		result = "",
	): string | undefined {
		if (discovery.has(name)) this.lastResult = result;
		if (name !== this.singleton?.name) return;
		const { startedAt } = this.singleton;
		this.singleton = undefined;
		this.streak.push({ name, milliseconds, startedAt });
		if (this.streak.length < 3) return;
		const recent = this.streak.slice(-3);
		const toolTotal = recent.reduce(
			(sum, timing) => sum + timing.milliseconds,
			0,
		);
		const elapsed = Math.max(0, now - recent[0].startedAt);
		if (elapsed < 2_000) return;
		this.streak = [];
		this.reminders++;
		this.awaitingNext = true;
		const slowest = recent.reduce((left, right) =>
			left.milliseconds >= right.milliseconds ? left : right,
		);
		const detail = recent
			.map(
				({ name: tool, milliseconds: ms }) =>
					`${tool} ${(ms / 1_000).toFixed(1)}s`,
			)
			.join(", ");
		return `${BATCH_REMINDER} spanned ${(elapsed / 1_000).toFixed(1)}s wall-clock (${(toolTotal / 1_000).toFixed(1)}s cumulative tool runtime: ${detail}); slowest: ${slowest.name} ${(slowest.milliseconds / 1_000).toFixed(1)}s. batch at most 3 independent, bounded discovery calls in one parallel tool batch to reduce serial latency; prefer module_report, read_symbol, and reads with explicit limits; never batch unbounded full-file reads. this does not imply cpu multithreading; keep dependent calls serial.`;
	}
}
