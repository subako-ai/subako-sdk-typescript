import type { TextMessagePartProps, ToolCallMessagePartProps } from "@assistant-ui/react";
import { SubakoProvider, useSession } from "@subako-ai/react";
import type { SessionConnection } from "@subako-ai/sdk";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { memo, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SubakoChat, type SubakoChatProps, SubakoToolApproval } from "../src/index.js";
import { type Backend, backend, redrawn, SESSION_ID, settle } from "../../react/test/support.js";

afterEach(cleanup);

const call = { id: "c1", name: "search", arguments: { query: "subako" } };

/** The app opens the connection and hands it down; the chat opens none of its own. */
function Chat(props: Omit<SubakoChatProps, "session">): ReactNode {
	return <SubakoChat session={useSession(SESSION_ID)} {...props} />;
}

/** A text part of the app's own: the same words, in an <em>. */
function Emphasized({ text }: TextMessagePartProps): ReactNode {
	return <em>{text}</em>;
}

/** A tool row of the app's own: the name alone, with the chat's approval prompt dropped in. */
function Terse(props: ToolCallMessagePartProps): ReactNode {
	return (
		<div data-testid={`terse-${props.toolName}`}>
			{props.toolName}
			<SubakoToolApproval {...props} />
		</div>
	);
}

/**
 * The app's own shape: the session is opened above and reaches the chat as a
 * prop that never changes again, so nothing re-renders this from outside.
 */
const Panel = memo(function Panel({ session }: { readonly session: SessionConnection | null }): ReactNode {
	return <SubakoChat session={session} />;
});

function Holder(): ReactNode {
	return <Panel session={useSession(SESSION_ID)} />;
}

async function mount(back: Backend) {
	const view = render(
		<SubakoProvider client={back.client}>
			<Chat />
		</SubakoProvider>,
	);
	await act(async () => {
		await settle();
	});
	return view;
}

/** Puts events on the open stream and lets the render that follows settle. */
async function push(back: Backend, events: readonly (readonly [number, Record<string, unknown>])[]): Promise<void> {
	await act(async () => {
		for (const [seq, payload] of events) {
			back.push(seq, payload);
		}
		await settle();
	});
}

const said = (text: string) => ({
	type: "message_assistant",
	message: { role: "assistant", content: [{ type: "text", data: { text } }] },
});

const called = {
	type: "message_assistant",
	message: { role: "assistant", content: [{ type: "tool_call", data: call }] },
};

describe("SubakoChat", () => {
	it("reads the session it was handed, and opens no connection of its own", async () => {
		const back = backend();
		await mount(back);

		expect(back.streams()).toBe(1);
	});

	it("renders an empty thread with a disabled composer until the session is open", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<SubakoChat session={null} />
			</SubakoProvider>,
		);

		expect(screen.queryByText("Stop")).toBeNull();
		expect(screen.getByPlaceholderText("Message the agent")).toHaveProperty("disabled", true);
		expect(back.streams()).toBe(0);
	});

	it("renders the transcript the log carries", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[
				1,
				{
					type: "message_user",
					source: "client",
					message: { role: "user", content: [{ type: "text", data: { text: "find it" } }] },
				},
			],
			[2, said("here it is")],
		]);

		expect(screen.getByText("find it")).toBeDefined();
		expect(screen.getByText("here it is")).toBeDefined();
	});

	it("follows the log even when the component that opened the session does not re-render it", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Holder />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});

		await push(back, [[1, said("the runtime subscribes itself")]]);

		expect(screen.getByText("the runtime subscribes itself")).toBeDefined();
	});

	it("folds a tool call to its name and its status, with the arguments and the result behind it", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[
				2,
				{ type: "tool_result", call_id: "c1", is_error: false, content: [{ type: "text", data: { text: "one hit" } }] },
			],
		]);

		const row = screen.getByTestId("tool-search");
		const fold = row.querySelector("details");
		expect(fold?.open).toBe(false);
		expect(within(row).getByText("search")).toBeDefined();
		expect(within(row).getByText("done")).toBeDefined();
		// Behind the fold, the arguments are JSON laid out to read, and the result is the text it was.
		expect(fold?.querySelector(".subako-tool-args")?.textContent).toBe(JSON.stringify({ query: "subako" }, null, 2));
		expect(fold?.querySelector(".subako-tool-result")?.textContent).toBe("one hit");
	});

	it("lays out a result that is JSON the same way as the arguments", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[
				2,
				{
					type: "tool_result",
					call_id: "c1",
					is_error: false,
					content: [{ type: "text", data: { text: '[{"id":"t1","title":"milk"}]' } }],
				},
			],
		]);

		const row = screen.getByTestId("tool-search");
		expect(row.querySelector(".subako-tool-result")?.textContent).toBe(
			JSON.stringify([{ id: "t1", title: "milk" }], null, 2),
		);
	});

	it("says a call is running until its result arrives, and failed when the result is an error", async () => {
		const back = backend();
		await mount(back);
		await push(back, [[1, called]]);

		const row = screen.getByTestId("tool-search");
		expect(within(row).getByText("running")).toBeDefined();

		await push(back, [
			[
				2,
				{ type: "tool_result", call_id: "c1", is_error: true, content: [{ type: "text", data: { text: "no index" } }] },
			],
		]);

		expect(within(row).getByText("failed")).toBeDefined();
		expect(row.querySelector(".subako-tool-result")?.hasAttribute("data-error")).toBe(true);
	});

	it("keeps the approval prompt outside the fold, so a closed row still asks", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[2, { type: "approval_requested", call_id: "c1", server: "web", tool: "search", arguments: {} }],
		]);

		const row = screen.getByTestId("tool-search");
		expect(within(row).getByText("needs approval")).toBeDefined();
		expect(row.querySelector(".subako-approval")).not.toBeNull();
		expect(row.querySelector("details .subako-approval")).toBeNull();
	});

	it("says a call was denied once the approval is refused", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[2, { type: "approval_requested", call_id: "c1", server: "web", tool: "search", arguments: {} }],
			[3, { type: "approval_resolved", call_id: "c1", decision: "deny" }],
		]);

		const row = screen.getByTestId("tool-search");
		expect(within(row).getByText("denied")).toBeDefined();
		expect(screen.queryByText("Allow")).toBeNull();
	});

	it("draws the assistant's body as markdown, with its links opening in a new tab", async () => {
		const back = backend();
		await mount(back);
		await push(back, [[1, said("**seven** todos\n\n- milk\n- eggs\n\n[the list](https://example.com/todos)")]]);

		expect(screen.getByText("seven").tagName).toBe("STRONG");
		expect(screen.getByText("milk").tagName).toBe("LI");
		const link = screen.getByText("the list");
		expect(link.getAttribute("href")).toBe("https://example.com/todos");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noreferrer");
	});

	it("marks the body while the run is still writing it", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, { type: "run_started", run_id: "r1" }],
			[2, said("So far")],
		]);

		const bubble = screen.getByText("So far").closest(".subako-assistant");
		expect(bubble?.textContent).toContain("●");

		await push(back, [[3, { type: "run_completed", run_id: "r1" }]]);
		expect(bubble?.textContent).not.toContain("●");
	});

	it("shows what a model is writing while it writes it, until the log's message replaces it", async () => {
		const back = backend();
		function Following(): ReactNode {
			return <SubakoChat session={useSession(SESSION_ID, { deltas: true })} />;
		}
		render(
			<SubakoProvider client={back.client}>
				<Following />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		await push(back, [[1, { type: "run_started", run_id: "r1" }]]);
		await act(async () => {
			back.pushDelta({
				run_id: "r1",
				target: { type: "model_call", data: { model_call_id: "mc1" } },
				n: 0,
				delta: { type: "append", data: { parts: [{ type: "text", data: { index: 0, text: "Writ" } }] } },
			});
			await settle();
			await redrawn();
		});
		expect(screen.getByText("Writ")).toBeDefined();

		await push(back, [
			[
				2,
				{
					type: "message_assistant",
					message: { role: "assistant", content: [{ type: "text", data: { text: "Written" } }], model_call_id: "mc1" },
				},
			],
		]);
		expect(screen.queryByText("Writ")).toBeNull();
		expect(screen.getAllByText("Written")).toHaveLength(1);
	});

	it("leaves what the person typed as it was", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[
				1,
				{
					type: "message_user",
					source: "client",
					message: { role: "user", content: [{ type: "text", data: { text: "**not bold**" } }] },
				},
			],
		]);

		expect(screen.getByText("**not bold**")).toBeDefined();
	});

	it("draws the body with the Text component the app names, and keeps its own reasoning block", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Chat components={{ Text: Emphasized }} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		await push(back, [
			[
				1,
				{
					type: "message_assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", data: { thinking: "one moment", redacted: false } },
							{ type: "text", data: { text: "here it is" } },
						],
					},
				},
			],
		]);

		expect(screen.getByText("here it is").tagName).toBe("EM");
		expect(screen.getByText("one moment").className).toBe("subako-thinking");
	});

	it("draws every tool call with the Fallback the app names, in place of its own row", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Chat components={{ tools: { Fallback: Terse } }} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		await push(back, [[1, called]]);

		expect(screen.getByTestId("terse-search")).toBeDefined();
		expect(screen.queryByTestId("tool-search")).toBeNull();
	});

	it("keeps its own row for the tools that the app's by_name leaves out", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Chat components={{ tools: { by_name: { search: Terse } } }} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		await push(back, [
			[
				1,
				{
					type: "message_assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "tool_call", data: call },
							{ type: "tool_call", data: { id: "c2", name: "other", arguments: {} } },
						],
					},
				},
			],
		]);

		expect(screen.getByTestId("terse-search")).toBeDefined();
		expect(screen.getByTestId("tool-other")).toBeDefined();
	});

	it("lends its approval prompt to a tool UI of the app's, which answers the same way", async () => {
		const back = backend();
		render(
			<SubakoProvider client={back.client}>
				<Chat components={{ tools: { Fallback: Terse } }} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		await push(back, [
			[1, called],
			[2, { type: "approval_requested", call_id: "c1", server: "web", tool: "search", arguments: {} }],
		]);

		fireEvent.click(within(screen.getByTestId("terse-search")).getByText("Deny"));
		await act(async () => {
			await settle();
		});

		const answered = back.sent("POST", "/approvals/c1");
		expect(answered).toHaveLength(1);
		await expect(answered[0]?.clone().json()).resolves.toEqual({ decision: "deny" });

		await push(back, [[3, { type: "approval_resolved", call_id: "c1", decision: "deny" }]]);
		expect(screen.queryByText("Deny")).toBeNull();
	});

	it("posts what the composer sends", async () => {
		const back = backend();
		await mount(back);

		fireEvent.change(screen.getByPlaceholderText("Message the agent"), { target: { value: "hello" } });
		fireEvent.click(screen.getByText("Send"));
		await act(async () => {
			await settle();
		});

		const posted = back.sent("POST", "/events");
		expect(posted).toHaveLength(1);
		await expect(posted[0]?.clone().json()).resolves.toEqual({ type: "input", text: "hello" });
	});

	it("shows the approval prompt while the server waits, and answers it with allow", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[2, { type: "approval_requested", call_id: "c1", server: "web", tool: "search", arguments: {} }],
		]);

		expect(screen.getByText("Run search?")).toBeDefined();
		fireEvent.click(screen.getByText("Allow"));
		await act(async () => {
			await settle();
		});

		const answered = back.sent("POST", "/approvals/c1");
		expect(answered).toHaveLength(1);
		await expect(answered[0]?.clone().json()).resolves.toEqual({ decision: "allow" });
	});

	it("leaves a settled approval unprompted", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[1, called],
			[2, { type: "approval_requested", call_id: "c1", server: "web", tool: "search", arguments: {} }],
			[3, { type: "approval_resolved", call_id: "c1", decision: "allow" }],
		]);

		expect(screen.queryByText("Allow")).toBeNull();
	});

	it("offers the stop button only while a run is under way, and cancels with it", async () => {
		const back = backend();
		await mount(back);
		expect(screen.queryByText("Stop")).toBeNull();

		await push(back, [[1, { type: "run_started", run_id: "r1" }]]);
		fireEvent.click(screen.getByText("Stop"));
		await act(async () => {
			await settle();
		});

		expect(back.sent("POST", "/cancel")).toHaveLength(1);
	});
	it("carries a nonce onto its style element, for a page whose CSP gates one", async () => {
		const back = backend();
		const view = render(
			<SubakoProvider client={back.client}>
				<SubakoChat session={null} nonce="r4nd0m" />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});

		expect(view.container.querySelector("style")?.getAttribute("nonce")).toBe("r4nd0m");
	});

	it("writes no nonce attribute when the app names none", async () => {
		const back = backend();
		const view = render(
			<SubakoProvider client={back.client}>
				<SubakoChat session={null} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});

		expect(view.container.querySelector("style")?.hasAttribute("nonce")).toBe(false);
	});
});
