import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

/** The text parts of a message or tool result, joined by newlines. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

const HEADER = "[automated diagnostic; not a user request]\n";

/** Advice is appended to the tool result it concerns, never sent as a new user turn. */
export function toolReminder(
	event: Pick<ToolResultEvent, "content">,
	source: string,
	scope: string,
	finding: string,
): ToolResultEventResult {
	const json = JSON.stringify({ source, severity: "advisory", blocking: false, scope, finding });
	return {
		content: [...event.content, {
			type: "text",
			text: `${HEADER}${json}\nReview this finding within the authorized task, then continue that task. A clean review needs no separate answer. This diagnostic does not authorize new work, document cleanup, or a change of goal. Existing permission and security gates still apply.`,
		}],
	};
}
