import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "../vendor/web-tree-sitter/tree-sitter.js";

export interface ShellCommand {
	text: string;
	name: string | undefined;
	rawName: string | undefined;
	args: Array<string | undefined>;
	rawArgs: string[];
	startIndex: number;
}

export interface ShellAnalysis {
	commands: ShellCommand[];
	writesFile: boolean;
	hasError: boolean;
	/** Literal `NAME=value` assignments, so `git -C $NAME` resolves to its repository. */
	variables: Record<string, string>;
}

await Parser.init();
const parser = new Parser();
parser.setLanguage(
	await Language.load(
		fileURLToPath(new URL("../vendor/tree-sitter-bash.wasm", import.meta.url)),
	),
);

function literal(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.type === "raw_string") return node.text.slice(1, -1);
	if (node.type === "string") {
		if (node.namedChildren.some((child) => child?.type !== "string_content"))
			return undefined;
		return node.text
			.slice(1, -1)
			.replace(/\\(["\\$`])/gu, "$1");
	}
	if (node.namedChildCount > 0) return undefined;
	return node.text.replace(/\\(.)/gu, "$1");
}

function command(node: Node): ShellCommand {
	const nameNode = node.childForFieldName("name");
	const name = literal(nameNode?.firstNamedChild ?? nameNode);
	const argumentNodes = node.childrenForFieldName("argument").filter((child) => child !== null);
	const args = argumentNodes.map((child) => literal(child));
	return {
		text:
			name && args.every((argument) => argument !== undefined)
				? [name, ...args].join(" ")
				: node.text,
		name,
		rawName: nameNode?.text,
		args,
		rawArgs: argumentNodes.map((child) => child.text),
		startIndex: node.startIndex,
	};
}

function redirectsToFile(node: Node): boolean {
	const operator = node.children.find((child) => child && !child.isNamed)?.type;
	if (!operator?.includes(">")) return false;
	const destination = node.childForFieldName("destination");
	if (operator === ">&" && destination?.type === "number") return false;
	if (destination?.type === "process_substitution") return false;
	return literal(destination) !== "/dev/null";
}

/** A command a shell line really executes, after stripping wrappers such as `env X=1`, `sudo -u u`, `timeout 5` or `bash -c '…'`. */
export interface ExecutedCommand {
	name: string;
	args: Array<string | undefined>;
	/** The wrapper ran something this parser cannot read (a computed name or script); guards should refuse rather than allow. */
	opaque?: true;
	/** Source text of the simple command this came from, so a guard can refuse only opaque commands that mention its target. */
	text?: string;
}

// Options that take a separate value, per wrapper; everything else starting with "-" is a flag.
const WRAPPERS: Record<string, RegExp | null> = {
	env: /^-(?:[uCS]|-unset|-chdir|-split-string)$/u,
	sudo: /^-(?:[ugpChDrtUT]|-user|-group|-prompt|-close-from|-host|-chdir|-role|-type|-other-user|-command-timeout)$/u,
	command: null,
	exec: /^-a$/u,
	nohup: null,
	nice: /^-(?:n|-adjustment)$/u,
	time: /^-(?:[fo]|-format|-output)$/u,
	timeout: /^-(?:[sk]|-signal|-kill-after)$/u,
	gtimeout: /^-(?:[sk]|-signal|-kill-after)$/u,
	stdbuf: /^-[ioe]$/u,
	caffeinate: /^-[tw]$/u,
	xargs: /^-(?:[IJLnPsEd]|-max-args|-max-procs|-replace|-delimiter)$/u,
	"sandbox-exec": /^-[pfnD]$/u,
};
const SHELLS = /^(?:ba|z|da|k|fi)?sh$/u;
const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** Every command the line executes, wrappers removed and `sh -c`/`eval` scripts parsed recursively. Quoted data never counts. */
export function executedCommands(source: string, depth = 0): ExecutedCommand[] {
	const { commands, variables } = analyzeShell(joinContinuations(source));
	return commands.flatMap(({ name, args, rawName, rawArgs, text }) => {
		// `base=/x; "$base/run" a` names a known program: substitute literal assignments from the same line, then this process's environment.
		name ??= substitute(rawName, variables);
		args = args.map((arg, i) => arg ?? substitute(rawArgs[i], variables));
		const found: ExecutedCommand[] = name === undefined ? [{ name: "", args, opaque: true }] : unwrap(name, args, depth);
		return found.map((command) => ({ ...command, text: command.text ?? text }));
	});
}

/** Bash removes backslash-newline before splitting words, except inside single quotes. */
function joinContinuations(source: string): string {
	let out = "";
	let single = false;
	let double = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i]!;
		if (char === "'" && !double) single = !single;
		if (char === '"' && !single) double = !double;
		if (!single && char === "\\") {
			if (source[i + 1] === "\n") { i++; continue; }
			out += char + (source[i + 1] ?? "");
			i++;
			continue;
		}
		out += char;
	}
	return out;
}

/** `tmux send-keys` types into another shell: text followed by Enter (or a typed CR/LF) runs there; Enter alone runs unknown earlier text. */
function sendKeys(rest: Array<string | undefined>, self: ExecutedCommand, depth: number): ExecutedCommand[] {
	let literal = false;
	let typed = "";
	for (let i = 0; i < rest.length; i++) {
		const key = rest[i];
		// Computed text only matters if a newline later submits it.
		if (key === undefined) { typed += "\uffff"; continue; }
		if (/^-[FHKlMRX]+$/u.test(key) && !typed) { literal ||= key.includes("l"); continue; }
		if (/^-[Nct]$/u.test(key) && !typed) { i++; continue; }
		typed += !literal && /^(?:Enter|C-m|C-j|KPEnter)$/u.test(key) ? "\n" : key;
	}
	// Other control bytes (ESC sequences, vi keys) can edit or run the line in ways this cannot simulate.
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(typed)) return [{ ...self, opaque: true }];
	const end = Math.max(typed.lastIndexOf("\n"), typed.lastIndexOf("\r"));
	if (end < 0) return [self];
	const script = typed.slice(0, end).replace(/\r/gu, "\n");
	return script.trim() && !script.includes("\uffff") ? [self, ...executedCommands(script, depth + 1)] : [{ ...self, opaque: true }];
}

function substitute(raw: string | undefined, variables: Record<string, string>): string | undefined {
	if (raw === undefined) return undefined;
	const text = raw.replace(/\$(?:\{(\w+)\}|(\w+))/gu, (match, braced, bare) => variables[braced ?? bare] ?? process.env[braced ?? bare] ?? match).replace(/"([^"$`\\]*)"/gu, "$1");
	return /[$`*?'"\\]/u.test(text) ? undefined : text;
}

function unwrap(name: string, args: Array<string | undefined>, depth: number): ExecutedCommand[] {
	const opaque = (): ExecutedCommand[] => [{ name, args, opaque: true }];
	const program = base(name);
	if (depth > 4) return opaque();
	const runs = (script: string | undefined) =>
		script === undefined ? opaque() : [{ name, args }, ...executedCommands(script, depth + 1)];
	// `sh -c SCRIPT` and tmux's run-shell/new-session/new-window/split-window/respawn-* SCRIPT hand a script to a shell.
	const flag = SHELLS.test(program)
		? args.findIndex((arg) => arg !== undefined && /^-[a-z]*c[a-z]*$/u.test(arg))
		: program === "tmux"
			? args.findIndex((arg) => arg !== undefined && /^(?:run(?:-shell)?|new(?:-session|-window|w)?|neww|split(?:-window|w)?|splitw|respawn-(?:pane|window)|respawnp|respawnw)$/u.test(arg))
			: -2;
	const send = program === "tmux" ? args.findIndex((arg) => arg === "send-keys" || arg === "send") : -1;
	if (send >= 0) return sendKeys(args.slice(send + 1), { name, args }, depth);
	if (flag === -1) return [{ name, args }];
	if (flag >= 0 && program !== "tmux") return runs(args[flag + 1]);
	if (flag >= 0) {
		const tail = args.slice(flag + 1);
		// Without a trailing word tmux starts the default shell; options' values are words too, so only a script-looking one counts.
		const script = tail.at(-1);
		const optionValue = tail.length > 1 && /^-\w*[cetnsFxylpT]$/u.test(tail.at(-2) ?? "");
		return tail.length === 0 || optionValue || (script !== undefined && script.startsWith("-")) ? [{ name, args }] : runs(script);
	}
	if (program === "eval") {
		if (args.some((arg) => arg === undefined)) return opaque();
		return [{ name, args }, ...executedCommands(args.join(" "), depth + 1)];
	}
	if (!(program in WRAPPERS)) return [{ name, args }];
	const valued = WRAPPERS[program];
	let index = 0;
	const rest = () => args.slice(index);
	while (index < args.length) {
		const arg = args[index];
		if (arg === undefined) return opaque();
		if (arg === "--") { index++; break; }
		if ((program === "env" || program === "time") && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) { index++; continue; }
		if (program === "env" && (arg === "-S" || arg === "--split-string" || arg.startsWith("--split-string="))) {
			const script = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
			if (script === undefined) return opaque();
			const tail = args.slice(index + (arg.includes("=") ? 1 : 2));
			if (tail.some((part) => part === undefined)) return opaque();
			return [{ name, args }, ...executedCommands([script, ...tail].join(" "), depth + 1)];
		}
		if (program === "command" && /^-[^-]*[vV]/u.test(arg)) return [{ name, args }];
		if (!arg.startsWith("-") || arg === "-") break;
		index += valued?.test(arg) ? 2 : 1;
	}
	if ((program === "timeout" || program === "gtimeout") && index < args.length) index++; // the duration
	if (program === "sudo" && args.slice(0, index).some((arg) => arg === "-e" || arg === "--edit" || arg === "-l" || arg === "--list" || arg === "-v" || arg === "-k" || arg === "-K")) return [{ name, args }];
	const [inner, ...innerArgs] = rest();
	if (inner === undefined) return index > args.length ? opaque() : [{ name, args }];
	return [{ name, args }, ...unwrap(inner, innerArgs, depth + 1)];
}

export function analyzeShell(source: string): ShellAnalysis {
	const tree = parser.parse(source);
	if (!tree)
		return { commands: [], writesFile: false, hasError: true, variables: {} };
	try {
		const root = tree.rootNode;
		return {
			commands: root
				.descendantsOfType("command")
				.flatMap((node) => (node ? [command(node)] : []))
				.sort((left, right) => left.startIndex - right.startIndex),
			writesFile: root
				.descendantsOfType("file_redirect")
				.some((node) => node !== null && redirectsToFile(node)),
			hasError: root.hasError,
			variables: Object.fromEntries(root.descendantsOfType("variable_assignment").flatMap((node) => {
				const value = literal(node?.childForFieldName("value") ?? null);
				return value === undefined ? [] : [[node!.childForFieldName("name")!.text, value]];
			})),
		};
	} finally {
		tree.delete();
	}
}
