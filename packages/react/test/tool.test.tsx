import type { SessionConnection, ToolAnswer, ToolClient } from "@subako-ai/sdk";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, StrictMode, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SubakoProvider, TOOL_ATTRIBUTE, useTool, useSession, useToolClient } from "../src/index.js";
import { type Backend, backend, CLIENT_ID, dispatched, SESSION_ID, settle } from "./support.js";

afterEach(cleanup);

const PARAMS = { type: "object", properties: { text: { type: "string" } } };

type Execute = (args: unknown) => ToolAnswer | Promise<ToolAnswer>;

/** The session the tree opened, so a test can mount clients under it; `null` until its effect ran. */
function Reader({ children }: { children: (session: SessionConnection | null) => ReactNode }): ReactNode {
	return children(useSession(SESSION_ID));
}

function Client({
	session,
	name = "chat",
	children,
}: {
	session: SessionConnection | null;
	name?: string;
	children?: (client: ToolClient | null) => ReactNode;
}): ReactNode {
	const client = useToolClient(session, name);
	return children?.(client) ?? null;
}

function Tool({
	client,
	name,
	description = "Fill it in.",
	execute = () => "done",
}: {
	client: ToolClient | null;
	name: string;
	description?: string;
	execute?: Execute;
}): ReactNode {
	useTool(client, name, { description, parameters: PARAMS, execute });
	return null;
}

function Watched({ client, execute }: { client: ToolClient | null; execute: Execute }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	useTool(client, "fill", { description: "Fill it in.", parameters: PARAMS, execute }, { target: box });
	return <div data-testid="box" ref={box} />;
}

/** The provider, one session, and one client, with the tools the test mounts under it. */
const tree = (back: Backend, children: (client: ToolClient | null) => ReactNode): ReactNode => (
	<SubakoProvider client={back.client}>
		<Reader>{(session) => <Client session={session}>{children}</Client>}</Reader>
	</SubakoProvider>
);

const attribute = (): string | null =>
	document.querySelector("[data-testid='box']")?.getAttribute(TOOL_ATTRIBUTE) ?? null;

const settled = async (): Promise<void> => {
	await act(async () => {
		await settle();
	});
};

describe("useToolClient", () => {
	it("creates one client on the session's connection and deletes it when it unmounts", async () => {
		const back = backend();
		const view = render(tree(back, () => null));
		await settled();

		expect(back.streams()).toBe(1);
		const registrations = back.sent("POST", "/clients");
		expect(registrations).toHaveLength(1);
		expect(await registrations[0]?.json()).toEqual({
			name: "chat",
			lifetime: { type: "ttl", data: { seconds: 60 } },
			tools: [],
		});

		view.unmount();
		await settled();
		expect(back.sent("DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(1);
	});

	it("registers on the connection StrictMode's remount left open", async () => {
		const back = backend();
		const clients: ToolClient[] = [];
		render(
			<StrictMode>
				{tree(back, (client) => {
					if (client !== null && !clients.includes(client)) {
						clients.push(client);
					}
					return null;
				})}
			</StrictMode>,
		);
		await settled();

		// The remount closed the first connection before any client was made on it, so one was.
		expect(back.streams()).toBe(2);
		expect(clients).toHaveLength(1);
		expect(clients[0]?.state.status).toBe("serving");
		expect(clients[0]?.state.id).toBe(CLIENT_ID);
		expect(back.sent("POST", "/clients")).toHaveLength(1);
	});

	it("gives one connection as many named clients as the app asks for", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Reader>
					{(session) => (
						<>
							<Client session={session} name="chat" />
							<Client session={session} name="contact-form" />
						</>
					)}
				</Reader>
			</SubakoProvider>,
		);
		await settled();

		expect(back.streams()).toBe(1);
		const registrations = back.sent("POST", "/clients");
		const names = await Promise.all(registrations.map(async (call) => ((await call.json()) as { name: string }).name));
		expect(names).toEqual(["chat", "contact-form"]);
	});
});

describe("useTool", () => {
	it("declares its tool in the registration, batches a second one, and keeps the client after the last", async () => {
		const back = backend();
		const view = render(tree(back, (client) => <Tool client={client} name="fill" />));
		await settled();

		// The tools the mounted components declared went out with the registration.
		expect(back.sent("POST", "/clients")).toHaveLength(1);
		expect(await back.sent("POST", "/clients")[0]?.json()).toEqual({
			name: "chat",
			lifetime: { type: "ttl", data: { seconds: 60 } },
			tools: [{ name: "fill", description: "Fill it in.", parameters: PARAMS }],
		});

		const pair = (client: ToolClient | null): ReactNode => (
			<>
				<Tool client={client} name="fill" />
				<Tool client={client} name="search" description="Search." />
			</>
		);
		view.rerender(tree(back, pair));
		await settled();

		// One update for the pair, not one per tool, and no second registration.
		const updates = back.sent("PUT", `/clients/${CLIENT_ID}/tools`);
		expect(updates).toHaveLength(1);
		expect(await updates[0]?.json()).toEqual({
			tools: [
				{ name: "fill", description: "Fill it in.", parameters: PARAMS },
				{ name: "search", description: "Search.", parameters: PARAMS },
			],
		});
		expect(back.sent("POST", "/clients")).toHaveLength(1);

		// A re-render hands both hooks fresh definitions; nothing about them changed.
		view.rerender(tree(back, pair));
		await settled();
		expect(back.sent("PUT", `/clients/${CLIENT_ID}/tools`)).toHaveLength(1);

		// The tools go and the client stays: it belongs to the session, not to the tools.
		view.rerender(tree(back, () => null));
		await settled();
		const withdrawn = back.sent("PUT", `/clients/${CLIENT_ID}/tools`);
		expect(withdrawn).toHaveLength(2);
		expect(await withdrawn[1]?.json()).toEqual({ tools: [] });
		expect(back.sent("DELETE", `/clients/${CLIENT_ID}`)).toHaveLength(0);
	});

	it("runs the handler for a dispatch and answers with what it returned", async () => {
		const back = backend();
		const seen: unknown[] = [];
		render(
			tree(back, (client) => (
				<Tool
					client={client}
					name="fill"
					execute={(args) => {
						seen.push(args);
						return "filled the form";
					}}
				/>
			)),
		);
		await settled();

		await act(async () => {
			back.push(1, dispatched("call-1", "fill", { text: "hello" }));
			await settle();
		});

		expect(seen).toEqual([{ text: "hello" }]);
		expect(back.sent("POST", "/calls/call-1/ack")).toHaveLength(1);
		const answers = back.sent("POST", "/calls/call-1/result");
		expect(await answers[0]?.json()).toEqual({ text: "filled the form" });
	});

	it("marks the target while the call runs and clears it when the call settles", async () => {
		const back = backend();
		let finish: ((answer: string) => void) | undefined;
		render(
			tree(back, (client) => (
				<Watched
					client={client}
					execute={() =>
						new Promise<string>((resolve) => {
							finish = resolve;
						})
					}
				/>
			)),
		);
		await settled();
		expect(attribute()).toBeNull();

		await act(async () => {
			back.push(1, dispatched("call-1", "fill"));
			await settle();
		});
		expect(attribute()).toBe("running");

		await act(async () => {
			finish?.("done");
			await settle();
		});
		expect(attribute()).toBeNull();
	});
});
