// The todo example's backend: the todo REST api the page reads, an MCP server
// the agent can read the todos through, and the agent this example publishes.
// The session routes and the agent bootstrap are examples/shared/server.mjs's.
//
//   node examples/todo/server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SubakoClient } from "@subako-ai/sdk";
import { z } from "zod";
import { credentials, json, readBody, serve } from "../shared/server.mjs";

const { env, agentConfig } = credentials();

const subako = new SubakoClient({
	baseUrl: env.SUBAKO_BASE_URL,
	apiKey: env.SUBAKO_API_KEY,
	workspaceId: env.SUBAKO_WORKSPACE_ID,
});

// ---------------------------------------------------------------- the todos

const today = new Date();
const inDays = (days) => new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);

let nextId = 1;
const make = (title, notes, due, completed) => ({
	id: `todo-${nextId++}`,
	title,
	notes,
	due,
	completed,
	created_at: new Date().toISOString(),
});

const todos = [
	make("Buy oat milk", "The barista kind, not the blue carton.", inDays(1), false),
	make("Renew the domain", "kikuvi.com expires at the end of the month.", inDays(12), false),
	make("Book the dentist", "", null, false),
	make("Water the ferns", "The one on the landing is dramatic about it.", inDays(2), false),
	make("File the receipts", "August, in the shoebox.", null, true),
	make("Cancel the gym trial", "", null, true),
];

const matching = (status) =>
	status === "completed"
		? todos.filter((todo) => todo.completed)
		: status === "active"
			? todos.filter((todo) => !todo.completed)
			: todos;

// ------------------------------------------------------------ the mcp server

/** One MCP server per request, which is what a stateless Streamable HTTP endpoint is. */
function mcpServer() {
	const server = new McpServer({ name: "todos", version: "1.0.0" });
	server.registerTool(
		"list_todos",
		{
			title: "List todos",
			description: "Read the todo list of this app. Use it before answering anything about the todos.",
			inputSchema: {
				status: z.enum(["active", "completed", "all"]).optional().describe("Which todos to read; all by default."),
			},
		},
		({ status }) => ({
			content: [{ type: "text", text: JSON.stringify(matching(status ?? "all")) }],
		}),
	);
	server.registerTool(
		"get_todo",
		{
			title: "Get one todo",
			description: "Read one todo by its id, notes and due date included.",
			inputSchema: { id: z.string().describe("The todo's id, as list_todos reports it.") },
		},
		({ id }) => {
			const todo = todos.find((candidate) => candidate.id === id);
			return todo === undefined
				? { isError: true, content: [{ type: "text", text: `no todo ${id}` }] }
				: { content: [{ type: "text", text: JSON.stringify(todo) }] };
		},
	);
	return server;
}

async function handleMcp(request, response) {
	const server = mcpServer();
	// Stateless: no session header to keep, and a plain JSON answer rather than a stream.
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response);
}

// ----------------------------------------------------------------- the agent

// The date is part of the prompt because the model has no clock, and "tomorrow" is a due date
// the person will say. It is also part of the config hash, so the first start of a day republishes.
const todayIso = () => new Date().toISOString().slice(0, 10);

const systemPrompt = () => `You are the assistant embedded in a small todo web app, and you drive the page the
person is looking at. Do what they ask by calling tools; keep your replies to a sentence or two.

Today is ${todayIso()}. Work out any date the person names — "tomorrow", "next Friday" — from that,
and write it as YYYY-MM-DD. Never ask them what today's date is.

The app has three pages:
- "/" the todo list, with three tabs: active, completed, all.
- "/todos/$todoId" one todo, with its notes and due date.
- "/settings" a settings form: a display name and a theme (light, dark, system).

The todo list also has an "Add todo" modal, whose form takes a title (required), notes, and a due date.

Every tool below belongs to the client named app. These four are offered wherever the person is:
- list_todos: read the list. It is the only way to see the todos — the page's own state is not in
  this conversation — and it is where the id the next two take comes from. Call it first.
- set_todo_done: mark one todo done, or put it back.
- delete_todo: delete one for good. Say which one you deleted; there is no undo.
- navigate: go to one of the app's routes.

These are declared by the part of the app they drive, so the tools you are offered say what is on
screen right now. When one you want is not there, navigate to the page that has it and try again:
- switch_tab: show the active, completed, or all tab. Only on the todo list.
- open_add_todo: open the "Add todo" modal. Only on the todo list. Call it before filling the form
  in; the form tool comes into being with the modal.
- fill_todo_form: fill the open modal's form. Fill in what the person said, leave the rest blank.
- submit_add_todo: submit that form, which is what creates the todo. Only while the modal is open.
- fill_settings: fill the settings form. Only on /settings.

A form tool takes every field at once. Leave a field blank to keep what it already has, and never
stop to ask which value to put in a field the person did not mention — fill what you know and say
what you left alone.

Creating a todo goes through the modal: open_add_todo, fill_todo_form, then submit_add_todo. There
is no tool that creates one outright. Submit when the person asked for the todo to be made; when
they only asked you to fill the form in, stop after filling it and let them send it.

If submit_add_todo answers with an error the form refused it. Put in what the person actually
gave you and submit again — never invent a value to get a form past its own validation. When they
gave you nothing to put there, say what the form is asking for and stop.

A form with no submit tool of its own, the settings form among them, is the person's to send:
filling it in is where your part ends.`;

// The broker refuses a plaintext MCP endpoint outright — and that failure kills the whole
// run — so the grant only goes out when EXAMPLE_MCP_URL names an https one it can reach.
const MCP_URL = process.env.EXAMPLE_MCP_URL;

const agent = {
	name: "example-todo",
	model: agentConfig.model,
	config: () => ({
		system_prompt: systemPrompt(),
		...(MCP_URL === undefined ? {} : { mcp: [{ name: "todos", url: MCP_URL, default_policy: "allow" }] }),
	}),
};

// -------------------------------------------------------------- the http api

async function routes(request, response, url) {
	const { method } = request;
	const path = url.pathname;

	if (path === "/mcp") {
		await handleMcp(request, response);
		return true;
	}
	if (path === "/api/todos" && method === "GET") {
		json(response, 200, { items: matching(url.searchParams.get("status") ?? "all") });
		return true;
	}
	if (path === "/api/todos" && method === "POST") {
		const body = await readBody(request);
		if (typeof body.title !== "string" || body.title.trim() === "") {
			json(response, 400, { error: "a todo needs a title" });
			return true;
		}
		const todo = make(body.title.trim(), typeof body.notes === "string" ? body.notes : "", body.due ?? null, false);
		todos.push(todo);
		json(response, 201, todo);
		return true;
	}
	const one = /^\/api\/todos\/([^/]+)$/.exec(path);
	if (one !== null && method === "DELETE") {
		const at = todos.findIndex((candidate) => candidate.id === one[1]);
		if (at === -1) {
			json(response, 404, { error: "no such todo" });
			return true;
		}
		const [gone] = todos.splice(at, 1);
		json(response, 200, gone);
		return true;
	}
	if (one !== null && method === "PATCH") {
		const todo = todos.find((candidate) => candidate.id === one[1]);
		if (todo === undefined) {
			json(response, 404, { error: "no such todo" });
			return true;
		}
		const body = await readBody(request);
		for (const key of ["title", "notes", "due", "completed"]) {
			if (body[key] !== undefined) {
				todo[key] = body[key];
			}
		}
		json(response, 200, todo);
		return true;
	}
	return false;
}

serve({ subako, agent, routes });
