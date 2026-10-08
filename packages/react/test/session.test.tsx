import type { SessionConnection, SessionState } from "@subako-ai/sdk";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubakoProvider, useSession, useSessionState } from "../src/index.js";
import { type Backend, backend, SESSION_ID, settle } from "./support.js";

afterEach(cleanup);
afterEach(() => {
	saw.length = 0;
	vi.restoreAllMocks();
});

const text = (body: string) => ({ role: "user", content: [{ type: "text", data: { text: body } }] });

/** The session the last render of `Reader` saw, so a test can drive it directly. */
let seen: SessionConnection | undefined;

/** What every render of `Reader` read, so a test can see the render before the effect. */
const saw: string[] = [];

/** What the component reads off one snapshot, including the render before the effect connected. */
const reads = (state: SessionState | null): string =>
	state === null
		? "none"
		: [state.status, state.transcript.length, state.approvals.length, state.isRunning ? "running" : "idle"].join("/");

/** `useSession` acquires and `useSessionState` reads, which is the pair an app that renders a session writes. */
function Reader(): ReactNode {
	const session = useSession(SESSION_ID);
	const state = useSessionState(session);
	if (session !== null) {
		seen = session;
	}
	saw.push(reads(state));
	return <span data-testid="reading">{reads(state)}</span>;
}

/** The same, subscribing to nothing: what it drew when its effect connected is what it keeps drawing. */
function Acquirer(): ReactNode {
	const session = useSession(SESSION_ID);
	if (session !== null) {
		seen = session;
	}
	return <span data-testid="acquired">{reads(session?.state ?? null)}</span>;
}

/** The session as a prop, so a test can hand the hook another one, or none. */
function Switcher({ id }: { id: string | null }): ReactNode {
	const session = useSession(id);
	if (session !== null) {
		seen = session;
	}
	saw.push(session === null ? "none" : session.sessionId);
	return <span data-testid="switched">{session === null ? "none" : session.sessionId}</span>;
}

function mount(back: Backend, children: ReactNode) {
	return render(<SubakoProvider client={back.client}>{children}</SubakoProvider>);
}

const reading = (): string | null => document.querySelector("[data-testid='reading']")?.textContent ?? null;

/** A reader that opens on the newest events only. */
function Windowed(): ReactNode {
	const session = useSession(SESSION_ID, { latest: 20 });
	return <span data-testid="reading">{reads(useSessionState(session))}</span>;
}

describe("the provider and useSession", () => {
	it("opens on the newest part of the log when told how much of it to read", async () => {
		const back = backend();
		mount(back, <Windowed />);
		await act(async () => {
			await settle();
		});

		const [read] = back.sent("GET", "/events");
		const query = new URL(read!.url).searchParams;
		expect([query.get("order"), query.get("limit")]).toEqual(["desc", "20"]);
		expect(reading()).toBe("open/0/0/idle");
	});

	it("opens one connection for every call, sharing nothing between them", async () => {
		const back = backend();
		mount(
			back,
			<>
				<Reader />
				<Reader />
			</>,
		);
		await act(async () => {
			await settle();
		});

		// The log is the source of truth, so two connections read the same session alike.
		expect(back.streams()).toBe(2);
		expect(back.sent("GET", "/events")).toHaveLength(2);
	});

	it("hands back nothing until its effect has connected", async () => {
		const back = backend();
		mount(back, <Reader />);

		// Nothing is opened while rendering: the first render reads no session at all.
		expect(saw[0]).toBe("none");

		await act(async () => {
			await settle();
		});
		expect(reading()).toBe("open/0/0/idle");
		expect(back.streams()).toBe(1);
	});

	it("hands back nothing again when the session it was asked for changes", async () => {
		const back = backend();
		const view = mount(back, <Switcher id="s1" />);
		await act(async () => {
			await settle();
		});
		expect(saw.at(-1)).toBe("s1");
		const first = seen;

		saw.length = 0;
		view.rerender(
			<SubakoProvider client={back.client}>
				<Switcher id="s2" />
			</SubakoProvider>,
		);

		// The render the change caused reads nothing: the connection it has is the session before it.
		expect(saw[0]).toBe("none");
		await act(async () => {
			await settle();
		});
		expect(saw.at(-1)).toBe("s2");
		expect(back.streams()).toBe(2);
		expect(first?.state.status).toBe("closed");
	});

	it("opens nothing for no session, and the session once it is named", async () => {
		const back = backend();
		const view = mount(back, <Switcher id={null} />);
		await act(async () => {
			await settle();
		});
		expect(saw).toEqual(["none"]);
		expect(back.streams()).toBe(0);

		view.rerender(
			<SubakoProvider client={back.client}>
				<Switcher id="s1" />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		expect(saw.at(-1)).toBe("s1");
		expect(back.streams()).toBe(1);
		const first = seen;

		view.rerender(
			<SubakoProvider client={back.client}>
				<Switcher id={null} />
			</SubakoProvider>,
		);
		await act(async () => {
			await settle();
		});
		// Naming none again closes the one it had.
		expect(saw.at(-1)).toBe("none");
		expect(first?.state.status).toBe("closed");
	});

	it("closes the connection when the hook unmounts", async () => {
		const back = backend();
		const view = mount(back, <Reader />);
		await act(async () => {
			await settle();
		});
		const session = seen;
		expect(session?.state.status).toBe("open");

		view.unmount();
		await act(async () => {
			await settle();
		});

		expect(session?.state.status).toBe("closed");
	});

	it("acquires without subscribing: the reading only moves for a component that reads the state", async () => {
		const back = backend();
		mount(back, <Acquirer />);
		await act(async () => {
			await settle();
		});
		const acquired = (): string | null => document.querySelector("[data-testid='acquired']")?.textContent ?? null;

		await act(async () => {
			back.push(1, { type: "message_user", source: "client", message: text("fill the form") });
			await settle();
		});

		// The connection opened and the event reached it; nothing asked React to draw either.
		expect(seen?.state.status).toBe("open");
		expect(seen?.transcript).toHaveLength(1);
		expect(acquired()).toBe("connecting/0/0/idle");
	});

	it("re-renders on every event through useSessionState, deriving the transcript, the approvals and the run", async () => {
		const back = backend();
		mount(back, <Reader />);
		await act(async () => {
			await settle();
		});
		expect(reading()).toBe("open/0/0/idle");

		await act(async () => {
			back.push(1, { type: "message_user", source: "client", message: text("fill the form") });
			back.push(2, { type: "run_queued", run_id: "r1" });
			await settle();
		});
		expect(reading()).toBe("open/1/0/running");

		await act(async () => {
			back.push(3, {
				type: "approval_requested",
				call_id: "c1",
				server: "files",
				tool: "write",
				args_hash: "h",
				arguments: {},
			});
			await settle();
		});
		expect(reading()).toBe("open/1/1/running");

		await act(async () => {
			back.push(4, { type: "approval_resolved", call_id: "c1", decision: "allow" });
			back.push(5, { type: "run_completed", run_id: "r1" });
			await settle();
		});
		expect(reading()).toBe("open/1/0/idle");
	});

	it("keeps the connection and its messages across renders", async () => {
		const back = backend();
		mount(back, <Reader />);
		await act(async () => {
			await settle();
		});
		const first = seen;
		await act(async () => {
			back.push(1, { type: "message_user", source: "client", message: text("one") });
			await settle();
		});
		const firstMessage = seen?.transcript[0]?.message;
		await act(async () => {
			back.push(2, { type: "message_user", source: "client", message: text("two") });
			await settle();
		});
		expect(seen).toBe(first);
		// A later event appends; the message the log carried keeps its identity.
		expect(seen?.transcript[0]?.message).toBe(firstMessage);
		expect(seen?.transcript).toHaveLength(2);
	});

	it("connects again after StrictMode's remount closed the first connection", async () => {
		const back = backend();
		const connects = vi.spyOn(back.client, "connect");
		render(
			<StrictMode>
				<SubakoProvider client={back.client}>
					<Reader />
				</SubakoProvider>
			</StrictMode>,
		);
		await act(async () => {
			await settle();
		});

		// The remount closed the first connection, and the effect opened the one the app now reads.
		const made = connects.mock.results.map((result) => result.value as SessionConnection);
		expect(made).toHaveLength(2);
		expect(made[0]?.state.status).toBe("closed");
		expect(seen).toBe(made[1]);
		expect(seen?.state.status).toBe("open");
		expect(reading()).toBe("open/0/0/idle");
	});

	it("sends input, cancels, and resolves an approval through the session token", async () => {
		const back = backend();
		mount(back, <Reader />);
		await act(async () => {
			await settle();
		});

		await act(async () => {
			await seen?.send("hello");
			await seen?.cancel();
			await seen?.resolveApproval("c1", "deny", "not this one");
		});

		const posted = back.sent("POST", "/events");
		expect(posted).toHaveLength(1);
		expect(await posted[0]?.json()).toEqual({ type: "input", text: "hello" });
		expect(back.sent("POST", "/cancel")).toHaveLength(1);
		const decided = back.sent("POST", "/approvals/c1");
		expect(await decided[0]?.json()).toEqual({ decision: "deny", message: "not this one" });
		expect(posted[0]?.headers.get("authorization")).toBe(`Bearer sbk_st_${SESSION_ID}`);
	});
});
