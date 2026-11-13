import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/index.ts";

test("local recursive Bash grep is refused with the grep tool named; remote and plain grep pass", () => {
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const call = (command: string, toolName = "bash") => hooks.get("tool_call")!({ toolName, input: { command } });
	for (const command of ["grep -rln needle .", "cd repo && grep -n -R x src", "for d in a b; do grep -rl x $d; done", "timeout 60 grep -rIl x .", "/usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c 'grep -rn x . '"])
		assert.match(call(command)?.reason ?? "", /Use the grep tool/u, command);
	assert.match(call("git status; grep -rn x .; ls")?.reason ?? "", /nothing in this command ran/u);
	assert.ok(call("grep -rn x crates --include=*.rs")?.block, "an --include glob is not a named file");
	for (const command of ["git status; grep -rn x crates/game/scripts/assemble-assets.mjs; ls", "ls; grep -rn prepare README.md *.md 2>/dev/null | head -10", "grep -n x file.ts", "ls | grep -i foo", "ssh host 'grep -r x /srv'", "fleet run m <<'EOF'\ngrep -r x .\nEOF", "git grep -n x", "/usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c 'ssh host grep -r x /srv'"])
		assert.equal(call(command), undefined, command);
	assert.equal(call("grep -r x .", "read"), undefined);
	tools.pop();
	assert.equal(call("grep -rln needle ."), undefined, "without the grep tool there is nothing better to point to");
});

test("audit pkgs-a-5: long options, executable paths and mixed remote/local commands are checked per execution", () => {
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const call = (command: string) => hooks.get("tool_call")!({ toolName: "bash", input: { command } });
	for (const command of [
		"grep --recursive needle .",
		"grep --dereference-recursive needle src",
		"/usr/bin/grep -R needle .",
		"ssh host true; grep -R needle .",
		"wsl true && /usr/bin/grep --recursive needle src",
		"fleet run machine true; timeout 5 grep -R needle src",
		"env X=1 sudo -n timeout 5 /usr/bin/grep -R needle src",
		"sh -c 'ssh host true; grep --recursive needle .'",
		"eval 'grep --recursive needle .'",
		"grep -R -e needle --include=*.ts src",
		"grep --directories=recurse needle .",
		"grep -d recurse needle .",
		"grep -R needle src README.md",
	]) assert.match(call(command)?.reason ?? "", /nothing in this command ran.*Use the grep tool/u, command);
	for (const command of [
		"printf '%s\\n' 'grep --recursive needle .'",
		"command -v grep",
		"git grep --recursive needle",
		"grep -- --recursive src/app.ts",
		"grep -e recursive src/app.ts",
		"grep -R -e needle src/app.ts",
		"grep --recursive --regexp=needle src/app.ts",
		"grep --recursive -f patterns.txt src/app.ts",
		"ssh host '/usr/bin/grep --recursive needle .'",
		"wsl /usr/bin/grep --recursive needle .",
		"fleet run machine -- grep --recursive needle .",
		"ssh host true; grep -n needle src/app.ts",
		"cat <<'EOF'\ngrep --recursive needle .\nEOF",
		'bash -c "$CMD"', '"$S/render" -R x',
		'bash -c "grep $FLAGS needle ."', 'env X=1 "$GREP" -R needle .',
	]) assert.equal(call(command), undefined, command);
});

test("source-search guidance reaches the structured prompt before discovery", () => {
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const options = { selectedTools: ["read", "bash", "grep"], sections: { existing: "preserve other guidance" } as Record<string, string> };
	const begin = () => hooks.get("before_agent_start")!({ prompt: "Find the manager-sheet reopen bug", systemPromptOptions: options });
	assert.equal(begin(), undefined, "no whole-prompt replacement or follow-up message");
	const prompt = options.sections.repository_search!;
	assert.match(prompt, /use the grep tool.*gitignore-aware.*bounded matches and long lines/u);
	assert.match(prompt, /symbol_search for identifiers when available, instead of recursive Bash grep/u);
	assert.match(prompt, /Scope the known source directory/u);
	assert.match(prompt, /Explicit inspection of generated or ignored files remains allowed/u);
	assert.match(prompt, /name the exact files and bound the output/u);
	assert.equal(options.sections.existing, "preserve other guidance");
	begin();
	assert.equal(options.sections.repository_search, prompt, "guidance is stable across runs");
	options.selectedTools = ["read", "bash"];
	begin();
	assert.equal(options.sections.repository_search, undefined, "do not require an unavailable search tool");
});

test("efficiency advice stays attached to the relevant tool result, not a new user message", t => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const notices: Array<[string, string?]> = [];
	const status = new Map<string, string | undefined>();
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string, level?: string) => notices.push([message, level]), setStatus: (key: string, text?: string) => status.set(key, text) },
	};
	hooks.get("agent_start")!({}, ctx);
	let result: any;
	for (const [index, toolName] of ["read", "grep", "lsp_diagnostics"].entries()) {
		now = index * 3000;
		hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", name: toolName }] } });
		hooks.get("tool_execution_start")!({ toolCallId: String(index) });
		now += 100;
		result = hooks.get("tool_result")!({ toolName, toolCallId: String(index), content: [{ type: "text", text: "original result" }] }, ctx);
	}
	assert.equal(hooks.has("context"), false);
	assert.equal(result.content[0].text, "original result");
	assert.match(result.content[1].text, /"source":"efficient-tool-use"/);
	assert.match(result.content[1].text, /"blocking":false/);
	assert.deepEqual(notices.at(-1)?.[1], "warning");
	assert.match(String(notices.at(-1)?.[0]), /efficient tool use/u);
	assert.equal(status.get("efficient-tool-use"), "⚒ 0/1 batched");
	hooks.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "grep" }] } }, ctx);
	assert.equal(status.get("efficient-tool-use"), "⚒ 1/1 batched", "the next batch held several calls");
});

test("a truncated bash result keeps one of each run of same-shape lines; untruncated output and path lists stay", () => {
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const run = (text: string) => hooks.get("tool_result")!({ toolName: "bash", toolCallId: "x", content: [{ type: "text", text }] }, { hasUI: false })?.content[0].text ?? text;
	const denied = Array.from({ length: 233 }, (_, i) => `rm: run/scratch/guard-${i}/view.js: Permission denied`).join("\n");
	const notice = "\n\n[Showing lines 11772-12004 of 12004 (50.0KB limit). Full output: /tmp/pi-bash-x.log]";
	assert.equal(run(denied + "\n/dev/disk3s1s1 1.8Ti 13Gi 8.8Gi 60% /" + notice),
		"rm: run/scratch/guard-0/view.js: Permission denied\n(… 232 more lines like this)\n/dev/disk3s1s1 1.8Ti 13Gi 8.8Gi 60% /" + notice, "10-28 rm of read-only snapshots");
	assert.equal(run(denied), denied, "without Pi's full log nothing is dropped");
	const paths = Array.from({ length: 300 }, (_, i) => `./src/file-${i}.ts`).join("\n") + notice;
	assert.equal(run(paths), paths, "a path list is all information");
});

test("a mangled name of an active tool is answered with the real name (trade-auto-t212 run-dcdze3 11-06: copy_bash)", () => {
	const hooks = new Map<string, Function>();
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => ["read", "bash", "pi-mobile-share-file"] } as never);
	const end = (name: string) => hooks.get("message_end")!({ message: { role: "toolResult", toolName: name, isError: true, content: [{ type: "text", text: `Tool ${name} not found` }] } })?.message.content.at(-1).text;
	for (const name of ["copy_bash", "enlist_bash", "mcp__antml_canvas_cream__enlist_bash", "bash_placeholder_do_not_use"])
		assert.equal(end(name), "Did you mean `bash`? It is active: call it by that exact name.", name);
	assert.match(end("mcp__x__pi-mobile-share-file") ?? "", /`pi-mobile-share-file`/u);
	for (const name of ["bashful", "trade", "reader"]) assert.equal(end(name), undefined, `${name}: no whole-part match`);
});

test("a script that rewrites source files is pointed to the edit tool (workflow-income 11-04, half-applied)", () => {
	const hooks = new Map<string, Function>();
	const tools = ["bash", "grep"];
	extension({ on: (name: string, fn: Function) => hooks.set(name, fn), getActiveTools: () => tools } as never);
	const run = (command: string) => { hooks.get("tool_call")!({ toolName: "bash", toolCallId: "s", input: { command } }); return hooks.get("tool_result")!({ toolName: "bash", toolCallId: "s", content: [{ type: "text", text: "ok" }] }, { hasUI: false })?.content.at(-1).text ?? ""; };
	assert.match(run("node -e \"let s=fs.readFileSync('a.tsx','utf8');s=s.replace(x,y);fs.writeFileSync('a.tsx',s)\""), /edit tool/u);
	assert.match(run("sed -i '' 's/a/b/' src/app.py"), /edit tool/u);
	for (const command of ["sed -i '' 's/a/b/' data.csv", "node -e \"fs.writeFileSync('out.json', JSON.stringify(x))\""]) assert.doesNotMatch(run(command), /edit tool/u, command);
});
