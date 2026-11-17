import { BATCH_REMINDER, BATCH_REMINDER_AGAIN, DISCOVERY as discovery } from "./discovery.js";

const REPEATS = 3;
/** Bounded readers the batch reminder recommends when they are active. */
const STRUCTURED_READERS = ["module_report", "read_symbol"];

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
	/** A reminder the model ignores repeats on each next lone lookup, at most this many times; then it stays quiet until the next user message. */
	private again = 0;
	private repeatNow = false;
	private muted = false;

	/** `⚒ 2/3 batched`: of 3 reminders, 2 were followed by a batch of several calls before the model moved on; undefined until the first reminder. */
	footer(): string | undefined {
		return this.reminders ? `⚒ ${this.batchedAfter}/${this.reminders} batched` : undefined;
	}

	reset(): void {
		this.streak = [];
		this.singleton = undefined;
		this.awaitingNext = this.repeatNow = this.muted = false;
		this.again = 0;
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
		const args = message.content.flatMap(block => Object.values((block as { arguments?: object })?.arguments ?? {}));
		const dependent = args.some(arg => typeof arg === "string" && arg.length > 2 && this.lastResult.includes(arg.split("/").pop()!));
		if (dependent) this.streak = [];
		const lone = tools.length === 1 && discovery.has(tools[0]);
		// After a reminder: a batch of several calls ends it (counted), another lone lookup repeats it, a call that
		// uses the last result waits, anything else means the model moved on.
		if (this.awaitingNext && tools.length) {
			this.repeatNow = lone && !dependent && this.again > 0;
			if (tools.length > 1) this.batchedAfter++;
			if (!this.repeatNow && !(lone && dependent)) {
				this.awaitingNext = false;
				this.again = 0;
			}
		}
		this.singleton = lone ? { name: tools[0], startedAt: now } : undefined;
		if (!this.singleton && tools.length) this.streak = [];
	}

	complete(
		name: string,
		milliseconds: number,
		now = performance.now(),
		result = "",
		activeTools: readonly string[] = [],
	): string | undefined {
		if (discovery.has(name)) this.lastResult = result;
		if (name !== this.singleton?.name) return;
		const { startedAt } = this.singleton;
		this.singleton = undefined;
		if (this.repeatNow) {
			this.repeatNow = false;
			this.muted = !--this.again;
			return `${BATCH_REMINDER_AGAIN} (${REPEATS - this.again} of ${REPEATS}): this lookup was sent alone too. If your next lookups do not need this result, send them together in one parallel tool batch; keep dependent calls serial.${this.muted ? " This reminder now stays quiet until the next user message." : ""}`;
		}
		if (this.muted) return;
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
		this.again = REPEATS;
		const slowest = recent.reduce((left, right) =>
			left.milliseconds >= right.milliseconds ? left : right,
		);
		const detail = recent
			.map(
				({ name: tool, milliseconds: ms }) =>
					`${tool} ${(ms / 1_000).toFixed(1)}s`,
			)
			.join(", ");
		// Name only the structured readers this session actually has; others would invite calls to missing tools.
		const prefer = [...STRUCTURED_READERS.filter((tool) => activeTools.includes(tool)), "reads with explicit limits"];
		return `${BATCH_REMINDER} spanned ${(elapsed / 1_000).toFixed(1)}s wall-clock (${(toolTotal / 1_000).toFixed(1)}s cumulative tool runtime: ${detail}); slowest: ${slowest.name} ${(slowest.milliseconds / 1_000).toFixed(1)}s. batch at most 3 independent, bounded discovery calls in one parallel tool batch to reduce serial latency; prefer ${prefer.join(", ")}; never batch unbounded full-file reads. this does not imply cpu multithreading; keep dependent calls serial.`;
	}
}
