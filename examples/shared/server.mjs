// What every example's backend has in common: the credentials testbed/cloud.sh
// wrote, the bootstrap that publishes the example's own agent, and the two
// session routes a page needs. An example's server.mjs builds its SubakoClient,
// says which agent it wants, adds any routes of its own, and calls `serve`.
//
// This process holds the workspace api key. Nothing outside the machine may
// reach it, which is why it listens on loopback only; the page reaches it
// through Vite's proxy, same-origin.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Where testbed/cloud.sh put the credentials and the model config. */
export const STATE = new URL("../../testbed/.state/", import.meta.url);

export const PORT = Number(process.env.EXAMPLE_PORT ?? 9800);
export const WEB_PORT = Number(process.env.EXAMPLE_WEB_PORT ?? 5173);
/** The page's origins, which the agent has to allow before a browser may open a session to it. */
export const ORIGINS = [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`];

const readEnv = (url) =>
	Object.fromEntries(
		readFileSync(url, "utf8")
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => line.split(/=(.*)/s).slice(0, 2)),
	);

/** The credentials and the model config, as testbed/cloud.sh wrote them. */
export function credentials() {
	return {
		env: readEnv(new URL("sdk.env", STATE)),
		agentConfig: JSON.parse(readFileSync(new URL("agent-config.json", STATE), "utf8")),
	};
}

// ------------------------------------------------------- the agent bootstrap

const hashOf = (config) => createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);

function readState(name) {
	try {
		return JSON.parse(readFileSync(new URL(`${name}.json`, STATE), "utf8"));
	} catch {
		return {};
	}
}

function writeState(name, state) {
	const file = new URL(`${name}.json`, STATE);
	mkdirSync(dirname(fileURLToPath(file)), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Finds or creates the agent named, publishes a version whenever its config
 * moved, and opens the page's origins. `config()` is the example's part of the
 * version: the system prompt, and any MCP servers; the model comes from the
 * testbed's config, and the provider is the workspace's live one of that
 * format, or whatever SUBAKO_MODEL_PROVIDER_ID names.
 */
export async function bootstrapAgent(subako, { name, model, config }, log) {
	let agent;
	for await (const candidate of await subako.agents.list({ limit: 100 })) {
		if (candidate.name === name) {
			agent = candidate;
			break;
		}
	}
	agent ??= await subako.agents.create({ name });

	let providerId = process.env.SUBAKO_MODEL_PROVIDER_ID;
	if (providerId === undefined) {
		for await (const candidate of await subako.modelProviders.list({ limit: 100 })) {
			if (candidate.format === model.format) {
				providerId = candidate.id;
				break;
			}
		}
	}
	if (providerId === undefined) {
		throw new Error(`no live ${model.format} model provider in this workspace`);
	}

	const version = { model, ...config(), model_provider_id: providerId };
	const hash = hashOf(version);
	const state = readState(name);
	if (state.agentId !== agent.id || state.configHash !== hash) {
		const published = await subako.agents.publishVersion(agent.id, version);
		writeState(name, { agentId: agent.id, configHash: hash, versionId: published.id });
		log(`published ${agent.name} version ${published.id}`);
	} else {
		log(`${agent.name} is already on config ${hash}`);
	}
	await subako.agents.setSecurity(agent.id, { allowed_origins: ORIGINS });
	return agent.id;
}

// -------------------------------------------------------------- the http api

export const json = (response, status, body) => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};

/** Every request ends, whether or not there was still a head to write the failure into. */
const fail = (response, error) => {
	if (response.headersSent) {
		response.end();
		return;
	}
	json(response, 500, { error: String(error) });
};

export const readBody = (request) =>
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

/**
 * Serves the example: the two session routes, then whatever `routes` answers
 * for. `routes(request, response, url)` handles a request and resolves true,
 * or resolves false and the request is a 404. The port is open before the
 * agent is published; the session routes are what wait for it.
 */
export function serve({ subako, agent, routes = async () => false }) {
	const log = (...args) => console.log(`[${agent.name}]`, ...args);

	const bootstrapped = bootstrapAgent(subako, agent, log);
	bootstrapped.then(
		(id) => log(`agent ${id}`),
		(error) => {
			console.error(`[${agent.name}] bootstrap failed:`, error);
			process.exit(1);
		},
	);

	async function handle(request, response, url) {
		if (url.pathname === "/api/session" && request.method === "POST") {
			// A real backend authenticates the person here, and creates the session as them.
			const created = await subako.sessions.create({ agent_id: await bootstrapped, display_name: agent.name });
			json(response, 201, { sessionId: created.id });
			return;
		}
		const token = /^\/api\/session\/([^/]+)\/token$/.exec(url.pathname);
		if (token !== null && request.method === "GET") {
			// A real backend authenticates the person and checks this session is theirs before minting.
			await bootstrapped;
			const minted = await subako.sessions.mintToken(token[1]);
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(minted.session_token);
			return;
		}
		if (await routes(request, response, url)) {
			return;
		}
		json(response, 404, { error: `no route ${request.method} ${url.pathname}` });
	}

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
		handle(request, response, url).catch((error) => {
			console.error(`[${agent.name}]`, error);
			fail(response, error);
		});
	});
	server.listen(PORT, "127.0.0.1", () => {
		log(`listening on http://127.0.0.1:${PORT}`);
	});
	return server;
}
