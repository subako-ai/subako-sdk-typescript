// End-to-end run against the local stack: the backend creates a session with its
// api key, the browser client connects to the log with the session token, creates
// a tool client, posts input, lets the mock model call the tool, and reads the log back.
//
//   pnpm build && node testbed/smoke.mjs
import { readFileSync } from "node:fs";
import { SubakoClient, SubakoError, SubakoSessionClient } from "../packages/sdk/dist/index.js";

const env = Object.fromEntries(
	readFileSync(new URL("./.state/sdk.env", import.meta.url), "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => line.split(/=(.*)/s).slice(0, 2)),
);

const subako = new SubakoClient({
	baseUrl: env.SUBAKO_BASE_URL,
	apiKey: env.SUBAKO_API_KEY,
	workspaceId: env.SUBAKO_WORKSPACE_ID,
});

const agent = await subako.agents.get(env.SUBAKO_AGENT_ID);
console.log("agent:", agent.name);

const created = await subako.sessions.create({ agent_id: agent.id, display_name: "sdk smoke" });
console.log("session:", created.id, created.status);

// What a browser holds: session tokens, one per session, and nothing else.
const browser = new SubakoSessionClient({
	baseUrl: env.SUBAKO_BASE_URL,
	getToken: async (sessionId) =>
		sessionId === created.id ? created.session_token : (await subako.sessions.mintToken(sessionId)).session_token,
});

const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), 30_000);
const session = browser.connect(created.id, { signal: stop.signal });
let status = session.state.status;
session.subscribe((state) => {
	if (state.status !== status) {
		status = state.status;
		console.log("connection:", status);
	}
});

let served = 0;
const client = session.createToolClient("web", { onError: (error) => console.error("client:", error) });
client.addTool("open_contact_form", {
	description: "Navigate to the contact page and prefill the form with the given text.",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: (args, call) => {
		served += 1;
		console.log(`tool open_contact_form ${call.callId} ${JSON.stringify(args)}`);
		return "Navigated to /contact and prefilled the form.";
	},
});

try {
	await client.ready;
	console.log("client:", client.state.id, client.state.name);

	const submitted = await browser.postEvent(created.id, {
		type: "input",
		text: "I want to send an inquiry.",
	});
	console.log("run:", submitted.run_id, submitted.outcome);

	for await (const event of session) {
		const detail =
			event.type === "message_assistant"
				? JSON.stringify(event.message.content)
				: event.type === "client_tool_dispatched"
					? `${event.tool} ${JSON.stringify(event.arguments)}`
					: event.type === "run_failed"
						? event.error
						: "";
		console.log(`event #${event.seq} ${event.type} ${detail}`);
		if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
			break;
		}
	}
} catch (error) {
	if (error instanceof SubakoError) {
		console.error("connection failed:", error.constructor.name, error.status, error.code, error.message);
	} else {
		throw error;
	}
} finally {
	clearTimeout(timer);
}

const page = await subako.sessions.listEvents(created.id, { limit: 200, order: "asc" });
console.log("log:", page.items.map((event) => event.type).join(" > "));
console.log("calls:", client.state.calls.map((call) => `${call.tool}:${call.phase}`).join(" "));

await session.deleteToolClient(client);
session.close();

const answered = page.items.some((event) => event.type === "tool_result" && !event.is_error);
const settled = client.state.calls.every((call) => call.phase === "answered");
if (served !== 1 || !answered || !settled) {
	console.error(
		`smoke failed: the tool ran ${served} times, the answer reached the log: ${answered}, every call settled: ${settled}`,
	);
	process.exit(1);
}
console.log("done");
