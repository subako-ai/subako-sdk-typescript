// A stand-in for the Anthropic Messages API, driven by rules rather than a model:
// it reads the last user turn, the tools it was offered, and the calls that have
// already come back, and answers with the tool_use blocks a real model would emit.
// The fallback keeps testbed/smoke.mjs honest: one call to the first client tool,
// then a reply.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 9797);
// A real model takes a moment to think and streams its words; so does this one.
const thinkMs = Number(process.env.MOCK_ANTHROPIC_DELAY_MS ?? 800);
const wordMs = Number(process.env.MOCK_ANTHROPIC_WORD_MS ?? 40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (request) =>
	new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			try {
				resolve(body === "" ? {} : JSON.parse(body));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});

// ------------------------------------------------------- reading the request

/** Where the person last said something, which is where the turn the rules answer begins. */
function lastTurn(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return { text: content, from: i };
		const text = content.find((block) => block.type === "text");
		if (text) return { text: text.text, from: i };
	}
	return { text: "", from: 0 };
}

const hasToolResult = (messages) =>
	messages.some(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "tool_result"),
	);

/** A tool_result's text, whether the block carries a string or a list of blocks. */
function resultText(block) {
	const content = block.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Every tool call this conversation has made, joined to the result that came back. */
function calls(messages) {
	const made = [];
	const byId = new Map();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_use") {
				const call = { id: block.id, name: block.name, input: block.input ?? {}, result: undefined };
				made.push(call);
				byId.set(block.id, call);
			}
			if (block.type === "tool_result") {
				const call = byId.get(block.tool_use_id);
				if (call !== undefined) call.result = resultText(block);
			}
		}
	}
	return made;
}

// ------------------------------------------------------------- the tool names

/** The model sees `client__<client>__<tool>` and `mcp__<server>__<tool>`, so match on the suffix. */
const offered = (tools, short) => tools.find((tool) => tool.name === short || tool.name.endsWith(`__${short}`));

const answered = (made, short) =>
	made.find((call) => (call.name === short || call.name.endsWith(`__${short}`)) && call.result !== undefined);

let counter = 0;
const use = (tool, input) => ({ id: `toolu_mock_${(counter += 1)}`, name: tool.name, input });

const reply = (text) => ({ text, tool: null, stop: "end_turn" });
const callTool = (text, tool, input) => ({ text, tool: use(tool, input), stop: "tool_use" });

// ------------------------------------------------------------------ the rules

const ADD = /add|create|new|追加|作成/i;
const TABS = /tab|タブ|completed|active|完了|未完了/i;
const GOTO = /go to|goto|open|navigate|move to|移動|開いて|ページ/i;
const TODOS = /todo|task|summar|要約|一覧|タスク/i;
const SETTINGS = /display name|display_name|表示名|名前|theme|テーマ/i;

/** The page words the navigate rule understands, in the order they are tried. */
const PAGES = [
	{ to: "/settings", words: ["settings", "setting", "preferences", "設定"] },
	{ to: "/", words: ["home", "todos", "todo", "list", "tasks", "task", "ホーム", "一覧", "タスク"] },
];

/** What the person wants added, which is the text with the "add a new todo" prefix taken off. */
function titleOf(text) {
	const japanese = /^(.*?)\s*(?:を)?\s*(?:追加|作成)/.exec(text);
	if (japanese !== null && japanese[1].trim() !== "") {
		return japanese[1].trim();
	}
	const english = /(?:add|create|new)\s+(.*)$/i.exec(text);
	let rest = (english === null ? text : english[1]).trim();
	for (;;) {
		const shorter = rest.replace(/^(?:a|an|the|new|to-?do|todo|task|item|entry|called|named)\b[\s:,'"-]*/i, "").trim();
		if (shorter === rest) break;
		rest = shorter;
	}
	rest = rest.replace(/[.!?。、]+$/, "").trim();
	return rest === "" ? text.trim() : rest;
}

/** The name the person wants shown, which is what they said after naming the field. */
function nameOf(text) {
	const match = /(?:display name|display_name|name|表示名|名前)\s*(?:to|is|=|を|に)?\s*(.+)$/i.exec(text);
	return (match === null ? text : match[1]).trim().replace(/[.!?。、]+$/, "");
}

/** Which tab the person named; 完了 hides inside 未完了, so the negative is tried first. */
function tabOf(text) {
	if (/未完了|not done|incomplete|active|todo|残/i.test(text)) return "active";
	if (/completed|done|完了|済/i.test(text)) return "completed";
	if (/all|every|すべて|全部|全て/i.test(text)) return "all";
	return "all";
}

/** The count, how many are done, and what they are called. */
function summarise(json) {
	let todos;
	try {
		todos = JSON.parse(json);
	} catch {
		return `The todo list came back as: ${json}`;
	}
	if (!Array.isArray(todos)) {
		return `The todo list came back as: ${json}`;
	}
	const done = todos.filter((todo) => todo.completed === true).length;
	const titles = todos.map((todo) => todo.title).join(", ");
	return `You have ${todos.length} todos, ${done} of them completed: ${titles}.`;
}

/** The rules, in order; the first one that answers wins. */
const RULES = [
	// Adding a todo: open the modal, then fill its form in on the turn after.
	({ text, tools, made }) => {
		if (!ADD.test(text)) return null;
		if (answered(made, "fill_todo_form") !== undefined) {
			return reply("I filled the form in — please look it over and submit it.");
		}
		const fill = offered(tools, "fill_todo_form");
		if (answered(made, "open_add_todo") !== undefined && fill !== undefined) {
			return callTool("Let me fill that in.", fill, { title: titleOf(text) });
		}
		if (answered(made, "open_add_todo") !== undefined) {
			return reply("The add-todo form is open now — say that again and I will fill it in.");
		}
		const open = offered(tools, "open_add_todo");
		return open === undefined ? null : callTool("Let me open the add-todo form.", open, {});
	},
	// Going to a page: the route the person named, if this app declared it.
	({ text, tools, made }) => {
		if (!GOTO.test(text)) return null;
		const navigate = offered(tools, "navigate");
		if (navigate === undefined) return null;
		const routes = navigate.input_schema?.properties?.to?.enum ?? [];
		const lower = text.toLowerCase();
		const page = PAGES.find(
			(candidate) => routes.includes(candidate.to) && candidate.words.some((w) => lower.includes(w)),
		);
		if (page === undefined) return null;
		const done = answered(made, "navigate");
		if (done !== undefined) {
			return reply(`You are on ${done.input.to} now.`);
		}
		return callTool(`Taking you to ${page.to}.`, navigate, { to: page.to });
	},
	// Filling the settings form in, which only the settings page offers.
	({ text, tools, made }) => {
		if (!SETTINGS.test(text)) return null;
		const done = answered(made, "fill_settings");
		if (done !== undefined) {
			return reply(`The settings form now reads ${done.result}.`);
		}
		const tool = offered(tools, "fill_settings");
		return tool === undefined ? null : callTool("Filling that in.", tool, { display_name: nameOf(text) });
	},
	// Switching the todo list's tab.
	({ text, tools, made }) => {
		if (!TABS.test(text)) return null;
		const done = answered(made, "switch_tab");
		if (done !== undefined) {
			return reply(`Showing the ${done.input.tab} todos.`);
		}
		const tool = offered(tools, "switch_tab");
		return tool === undefined ? null : callTool("Switching the tab.", tool, { tab: tabOf(text) });
	},
	// Reading the todos, which only the MCP server can answer.
	({ text, tools, made }) => {
		if (!TODOS.test(text)) return null;
		const done = answered(made, "list_todos");
		if (done !== undefined) {
			return reply(summarise(done.result));
		}
		const tool = offered(tools, "list_todos");
		return tool === undefined ? null : callTool("Let me read your todo list.", tool, {});
	},
	// The fallback the smoke test rests on: one call to the first client tool, then a reply.
	({ text, tools, turn }) => {
		const clientTool = tools.find((tool) => tool.name.startsWith("client__"));
		if (clientTool === undefined || hasToolResult(turn)) return null;
		return callTool(`Let me use ${clientTool.name} for that.`, clientTool, { text });
	},
];

function plan(body) {
	const messages = body.messages ?? [];
	const tools = body.tools ?? [];
	// Only this turn's calls count, so the same request in a later turn is answered again.
	const { text, from } = lastTurn(messages);
	const turn = messages.slice(from);
	const input = { text, tools, turn, made: calls(turn) };
	for (const rule of RULES) {
		const answer = rule(input);
		if (answer !== null) return answer;
	}
	return reply(`mock reply to: ${text}`);
}

// ------------------------------------------------------------ the two wires

function content(answer) {
	const blocks = [{ type: "text", text: answer.text }];
	if (answer.tool) blocks.push({ type: "tool_use", ...answer.tool });
	return blocks;
}

function sseFrames(model, answer) {
	const frames = [];
	const push = (event) => frames.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	push({
		type: "message_start",
		message: {
			id: `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
	push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	for (const word of answer.text.match(/\S+\s*/g) ?? [answer.text]) {
		push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } });
	}
	push({ type: "content_block_stop", index: 0 });
	if (answer.tool) {
		push({
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: answer.tool.id, name: answer.tool.name, input: {} },
		});
		push({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(answer.tool.input) },
		});
		push({ type: "content_block_stop", index: 1 });
	}
	push({
		type: "message_delta",
		delta: { stop_reason: answer.stop, stop_sequence: null },
		usage: { output_tokens: 5 },
	});
	push({ type: "message_stop" });
	return frames;
}

const server = createServer(async (request, response) => {
	if (request.method !== "POST" || !request.url.startsWith("/v1/messages")) {
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock: no such route" } }));
		return;
	}
	const body = await readJson(request);
	const answer = plan(body);
	const model = body.model ?? "claude-mock";
	const names = (body.tools ?? []).map((tool) => tool.name).join(",");
	console.error(
		`[mock-anthropic] ${body.stream ? "stream" : "json"} tools=[${names}] -> ${answer.tool ? answer.tool.name : answer.stop}`,
	);
	if (body.stream) {
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		await sleep(thinkMs);
		for (const frame of sseFrames(model, answer)) {
			response.write(frame);
			if (frame.includes('"text_delta"')) await sleep(wordMs);
		}
		response.end();
		return;
	}
	await sleep(thinkMs);
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			id: `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			model,
			content: content(answer),
			stop_reason: answer.stop,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
	);
});

server.listen(port, "127.0.0.1", () => console.error(`[mock-anthropic] listening on http://127.0.0.1:${port}`));
