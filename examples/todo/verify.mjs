// The demo's end-to-end proof, for a machine with no browser: it plays the part
// of the page — the same session routes, the same client name, the same five
// tools — and checks that the agent drives it the way the app expects.
//
//   testbed/up.sh                     # the stack
//   node examples/todo/server.mjs &   # the example's own backend
//   node examples/todo/verify.mjs
import { readFileSync } from "node:fs";
import { SubakoClient, SubakoSessionClient } from "@subako-ai/sdk";

const DEMO = process.env.EXAMPLE_URL ?? `http://127.0.0.1:${process.env.EXAMPLE_PORT ?? 9800}`;
const STATE = new URL("../../testbed/.state/", import.meta.url);

const env = Object.fromEntries(
	readFileSync(new URL("sdk.env", STATE), "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => line.split(/=(.*)/s).slice(0, 2)),
);

const subako = new SubakoClient({
	baseUrl: env.SUBAKO_BASE_URL,
	apiKey: env.SUBAKO_API_KEY,
	workspaceId: env.SUBAKO_WORKSPACE_ID,
});

async function demo(path, init) {
	const response = await fetch(`${DEMO}${path}`, init);
	if (!response.ok) {
		throw new Error(
			`${init?.method ?? "GET"} ${path} answered ${response.status}; is examples/todo/server.mjs running?`,
		);
	}
	return response;
}

// The browser's two calls: the demo server creates the session and mints its tokens.
const { sessionId } = await (await demo("/api/session", { method: "POST" })).json();
console.log("session:", sessionId);

const browser = new SubakoSessionClient({
	baseUrl: env.SUBAKO_BASE_URL,
	getToken: async (id) => await (await demo(`/api/session/${id}/token`)).text(),
});

const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), 90_000);
const session = browser.connect(sessionId, { signal: stop.signal });

// --------------------------------------------------- the page the agent drives

const dispatched = [];
const record = (tool, answer) => async (args) => {
	const result = await answer(args);
	dispatched.push({ tool, args, result });
	console.log(`  tool ${tool} ${JSON.stringify(args)}`);
	return result;
};

const ROUTES = ["/", "/settings", "/todos/$todoId"];

const client = session.createToolClient("app", { onError: (error) => console.error("client:", error) });

client.addTool("navigate", {
	description: `Go to a page of this app. Routes: ${ROUTES.join(", ")}`,
	parameters: {
		type: "object",
		properties: { to: { type: "string", enum: ROUTES }, params: { type: "object" } },
		required: ["to"],
		additionalProperties: false,
	},
	execute: record("navigate", (args) => JSON.stringify({ location: args.to })),
});
client.addTool("switch_tab", {
	description: "Show the active, completed, or all tab of the todo list.",
	parameters: {
		type: "object",
		properties: { tab: { type: "string", enum: ["active", "completed", "all"] } },
		required: ["tab"],
		additionalProperties: false,
	},
	execute: record("switch_tab", (args) => `Showing the ${args.tab} tab.`),
});
client.addTool("open_add_todo", {
	description: "Open the add-todo modal, whose form fill_todo_form then fills in.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: record("open_add_todo", () => "The add-todo form is open."),
});
// The modal's form, which fill_todo_form writes to and submit_add_todo sends.
let form = { title: "", notes: "", due: "" };

client.addTool("fill_todo_form", {
	description: "Fill in the open add-todo form: title, notes, due.",
	parameters: {
		type: "object",
		properties: { title: { type: "string" }, notes: { type: "string" }, due: { type: "string" } },
		additionalProperties: false,
	},
	execute: record("fill_todo_form", (args) => {
		form = { ...form, ...args };
		return JSON.stringify({ values: form });
	}),
});
client.addTool("submit_add_todo", {
	description: "Submit the open add-todo form, which is what creates the todo. Fill it in first.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	execute: record("submit_add_todo", async () => {
		// The form's own validation, which is what a refusal has to look like to the model.
		if (form.title.trim() === "") {
			return { text: "the form refused it — title: a title is required", is_error: true };
		}
		await demo("/api/todos", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: form.title, notes: form.notes, due: form.due === "" ? null : form.due }),
		});
		form = { title: "", notes: "", due: "" };
		return "The form was submitted.";
	}),
});

// The todos the page holds, seeded from the demo server the way the app's own state is.
const todos = (await (await demo("/api/todos")).json()).items;

client.addTool("list_todos", {
	description: "Read this app's todo list, and the ids the other todo tools take.",
	parameters: {
		type: "object",
		properties: { status: { type: "string", enum: ["active", "completed", "all"] } },
		required: ["status"],
		additionalProperties: false,
	},
	execute: record("list_todos", (args) => {
		const status = args.status ?? "all";
		const shown = status === "all" ? todos : todos.filter((todo) => todo.completed === (status === "completed"));
		return JSON.stringify(shown);
	}),
});
client.addTool("set_todo_done", {
	description: "Mark one todo done, or put it back on the list. list_todos reports the id.",
	parameters: {
		type: "object",
		properties: { id: { type: "string" }, done: { type: "boolean" } },
		required: ["id", "done"],
		additionalProperties: false,
	},
	execute: record("set_todo_done", (args) => {
		const todo = todos.find((candidate) => candidate.id === args.id);
		if (todo === undefined) {
			return { text: `no todo ${args.id}`, is_error: true };
		}
		todo.completed = args.done === true;
		return `${todo.title} is now ${todo.completed ? "done" : "back on the list"}.`;
	}),
});
client.addTool("delete_todo", {
	description: "Delete one todo for good. list_todos reports the id.",
	parameters: {
		type: "object",
		properties: { id: { type: "string" } },
		required: ["id"],
		additionalProperties: false,
	},
	execute: record("delete_todo", (args) => {
		const at = todos.findIndex((candidate) => candidate.id === args.id);
		if (at === -1) {
			return { text: `no todo ${args.id}`, is_error: true };
		}
		const [gone] = todos.splice(at, 1);
		return `Deleted ${gone.title}.`;
	}),
});

// The settings form, answered the way `formTool` answers one: apply, then read the form back.
const settings = { display_name: "Sam", theme: "system" };
client.addTool("fill_settings", {
	description: "Fill in the settings form: the display name shown in the header, and the theme.",
	parameters: {
		type: "object",
		properties: {
			display_name: { type: "string" },
			theme: { type: "string", enum: ["light", "dark", "system"] },
		},
		additionalProperties: false,
	},
	execute: record("fill_settings", (args) => {
		Object.assign(settings, args);
		return JSON.stringify({ values: settings });
	}),
});

await client.ready;
console.log("client:", client.state.id, client.state.name);

// ------------------------------------------------------------- asking, and waiting

/** Posts one turn and hands back the events that turn produced. */
async function ask(text) {
	const from = session.state.lastSeq ?? 0;
	console.log(`\n> ${text}`);
	await session.send(text);
	for await (const event of session) {
		if (event.seq <= from) continue;
		if (event.type === "run_failed") {
			throw new Error(`the run failed: ${event.error}`);
		}
		if (event.type === "run_completed" || event.type === "run_cancelled") {
			break;
		}
	}
	return session.state.events.filter((event) => event.seq > from);
}

const failures = [];
const check = (ok, what) => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failures.push(what);
};

const assistantText = (events) =>
	events
		.filter((event) => event.type === "message_assistant")
		.flatMap((event) => event.message.content)
		.filter((block) => block.type === "text")
		.map((block) => block.data.text)
		.join(" ");

const calledTool = (events, suffix) =>
	events.some((event) => event.type === "tool_call" && event.name.endsWith(suffix));

const wasDispatched = (tool) => dispatched.filter((call) => call.tool === tool);

try {
	const summary = await ask("summarize my todos");
	check(calledTool(summary, "list_todos"), "the log shows a tool_call to list_todos");
	check(wasDispatched("list_todos").length >= 1, "list_todos was dispatched to the page");
	const reply = assistantText(summary);
	console.log(`  reply: ${reply}`);
	check(/\b\d+\b/.test(reply), "the assistant's reply carries a count");

	dispatched.length = 0;
	const added = await ask("add a todo buy milk");
	check(wasDispatched("open_add_todo").length === 1, "open_add_todo was dispatched");
	const fills = wasDispatched("fill_todo_form");
	check(fills.length === 1, "fill_todo_form was dispatched");
	check(wasDispatched("submit_add_todo").length === 1, "submit_add_todo was dispatched");
	check(
		dispatched.map((call) => call.tool).join(" > ") === "open_add_todo > fill_todo_form > submit_add_todo",
		`the three came in order (${dispatched.map((call) => call.tool).join(" > ")})`,
	);
	check(
		/buy milk/i.test(String(fills[0]?.args.title ?? "")),
		`fill_todo_form got a title containing "buy milk" (${JSON.stringify(fills[0]?.args.title)})`,
	);
	// The proof the submit did something: the demo server, which the form posted to, holds it.
	const stored = (await (await demo("/api/todos")).json()).items;
	check(
		stored.some((todo) => /buy milk/i.test(todo.title)),
		`the demo server holds the new todo (${JSON.stringify(stored.map((todo) => todo.title))})`,
	);
	console.log(`  reply: ${assistantText(added)}`);

	// Filling without submitting is still the other half of the contract.
	dispatched.length = 0;
	const filled = await ask("open the add todo form and fill in the title Water the plants, but do not submit it");
	check(wasDispatched("fill_todo_form").length === 1, "fill_todo_form was dispatched");
	check(wasDispatched("submit_add_todo").length === 0, "submit_add_todo was left alone");
	console.log(`  reply: ${assistantText(filled)}`);
	form = { title: "", notes: "", due: "" };

	dispatched.length = 0;
	const went = await ask("go to settings");
	const navigations = wasDispatched("navigate");
	check(navigations.length === 1, "navigate was dispatched");
	check(
		navigations[0]?.args.to === "/settings",
		`navigate went to /settings (${JSON.stringify(navigations[0]?.args)})`,
	);
	console.log(`  reply: ${assistantText(went)}`);

	dispatched.length = 0;
	const named = await ask("set my display name to Ada Lovelace");
	const settingsFills = wasDispatched("fill_settings");
	check(settingsFills.length === 1, "fill_settings was dispatched");
	check(
		/Ada Lovelace/i.test(String(settingsFills[0]?.args.display_name ?? "")),
		`fill_settings got the display name (${JSON.stringify(settingsFills[0]?.args.display_name)})`,
	);
	// The answer is the form read back after the fill, which is what tells the model it took.
	check(
		/Ada Lovelace/i.test(String(settingsFills[0]?.result ?? "")),
		`the answer carries the applied display name (${JSON.stringify(settingsFills[0]?.result)})`,
	);
	check(settings.display_name === "Ada Lovelace", "the page's own settings hold the applied name");
	console.log(`  reply: ${assistantText(named)}`);

	dispatched.length = 0;
	const done = await ask("mark the oat milk todo as done");
	const dones = wasDispatched("set_todo_done");
	check(dones.length === 1, "set_todo_done was dispatched");
	check(dones[0]?.args.done === true, `set_todo_done was asked to complete it (${JSON.stringify(dones[0]?.args)})`);
	check(todos.find((todo) => /oat milk/i.test(todo.title))?.completed === true, "the page's own todo is now done");
	console.log(`  reply: ${assistantText(done)}`);

	dispatched.length = 0;
	const before = todos.length;
	const removed = await ask("delete the dentist todo");
	check(wasDispatched("delete_todo").length === 1, "delete_todo was dispatched");
	check(todos.length === before - 1, `the page's list lost one todo (${before} -> ${todos.length})`);
	check(!todos.some((todo) => /dentist/i.test(todo.title)), "the dentist todo is gone from the page");
	console.log(`  reply: ${assistantText(removed)}`);
} finally {
	clearTimeout(timer);
	await session.deleteToolClient(client).catch(() => undefined);
	session.close();
	await subako.sessions.delete(sessionId).catch(() => undefined);
}

console.log();
if (failures.length > 0) {
	console.error(`verify failed: ${failures.length} check(s) — ${failures.join("; ")}`);
	process.exit(1);
}
console.log("verify: every check passed");
// The demo server keeps a socket to the stack open; nothing here is left to wait for.
process.exit(0);
