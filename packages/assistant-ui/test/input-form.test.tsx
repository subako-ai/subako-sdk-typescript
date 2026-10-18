import { SubakoProvider, useSession } from "@subako-ai/react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SubakoChat, type SubakoChatProps, type WidgetProps } from "../src/index.js";
import { type Backend, backend, json, SESSION_ID, settle } from "../../react/test/support.js";

afterEach(cleanup);

function Chat(props: Omit<SubakoChatProps, "session">): ReactNode {
	return <SubakoChat session={useSession(SESSION_ID)} {...props} />;
}

async function mount(back: Backend, props: Omit<SubakoChatProps, "session"> = {}) {
	render(
		<SubakoProvider client={back.client}>
			<Chat {...props} />
		</SubakoProvider>,
	);
	await act(async () => {
		await settle();
	});
}

async function push(back: Backend, events: readonly (readonly [number, Record<string, unknown>])[]): Promise<void> {
	await act(async () => {
		for (const [seq, payload] of events) {
			back.push(seq, payload);
		}
		await settle();
	});
}

async function click(element: HTMLElement): Promise<void> {
	fireEvent.click(element);
	await act(async () => {
		await settle();
	});
}

const select = (multiple: boolean, allowOther: boolean) => ({
	type: "select",
	data: {
		options: [{ label: "Tue", description: "the second day" }, { label: "Wed" }],
		multiple,
		allow_other: allowOther,
	},
});

const asked = (questions: readonly Record<string, unknown>[], callId = "c1") => ({
	type: "input_requested",
	call_id: callId,
	request: { questions },
});

async function answered(back: Backend, callId = "c1"): Promise<unknown> {
	const sent = back.sent("POST", `/inputs/${callId}`);
	expect(sent).toHaveLength(1);
	return await sent[0]?.clone().json();
}

/** A custom widget of the app's own: one button per seat. */
function Seats({ props, value, onChange }: WidgetProps): ReactNode {
	const seats = (props as { seats: string[] }).seats;
	return (
		<div>
			{seats.map((seat) => (
				<button key={seat} type="button" aria-pressed={value === seat} onClick={() => onChange([seat])}>
					{seat}
				</button>
			))}
		</div>
	);
}

describe("the forms an agent puts", () => {
	it("draws each built-in widget and submits one outcome per question", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[
				1,
				asked([
					{ id: "day", prompt: "Which day?", header: "Day", required: true, widget: select(false, false) },
					{ id: "extras", prompt: "Extras?", required: false, widget: select(true, true) },
					{ id: "notes", prompt: "Notes", required: false, widget: { type: "text", data: { multiline: true } } },
					{ id: "name", prompt: "Name", required: false, widget: { type: "text", data: { multiline: false } } },
					{ id: "ok", prompt: "Proceed?", required: false, widget: { type: "confirm" } },
				]),
			],
		]);
		const form = screen.getByTestId("input-c1");
		expect(within(form).getAllByText("the second day")).toHaveLength(2);
		const submit = within(form).getByText("Submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		const [dayTue] = within(form).getAllByRole("radio");
		const [extrasTue, extrasWed] = within(form).getAllByRole("checkbox");
		fireEvent.click(dayTue as HTMLElement);
		expect(submit.disabled).toBe(false);
		fireEvent.click(extrasTue as HTMLElement);
		fireEvent.click(extrasWed as HTMLElement);
		fireEvent.click(extrasWed as HTMLElement);
		fireEvent.change(within(form).getByPlaceholderText("Other"), { target: { value: "Fri" } });
		fireEvent.change(within(form).getByLabelText("Notes"), { target: { value: "aisle" } });
		fireEvent.click(within(form).getByText("Yes"));
		await click(submit);

		await expect(answered(back)).resolves.toEqual({
			type: "submitted",
			data: {
				answers: [
					{ question_id: "day", outcome: { type: "answered", data: { value: ["Tue"] } } },
					{ question_id: "extras", outcome: { type: "answered", data: { value: ["Tue", "Fri"] } } },
					{ question_id: "notes", outcome: { type: "answered", data: { value: "aisle" } } },
					{ question_id: "name", outcome: { type: "skipped" } },
					{ question_id: "ok", outcome: { type: "answered", data: { value: true } } },
				],
			},
		});

		await push(back, [[2, { type: "input_resolved", call_id: "c1", resolution: { type: "expired" } }]]);
		expect(screen.queryByTestId("input-c1")).toBeNull();
	});

	it("draws a custom widget with the app's renderer", async () => {
		const back = backend();
		await mount(back, { widgets: { seat_picker: Seats } });
		await push(back, [
			[
				1,
				asked([
					{
						id: "seat",
						prompt: "Where?",
						required: true,
						widget: { type: "custom", data: { id: "seat_picker", props: { seats: ["A1", "A2"] } } },
					},
				]),
			],
		]);
		await click(screen.getByText("A2"));
		await click(screen.getByText("Submit"));
		await expect(answered(back)).resolves.toEqual({
			type: "submitted",
			data: { answers: [{ question_id: "seat", outcome: { type: "answered", data: { value: ["A2"] } } }] },
		});
	});

	it("sends what this app cannot draw as unsupported, beside what it can", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[
				1,
				asked([
					{ id: "day", prompt: "Which day?", required: false, widget: select(false, false) },
					{
						id: "seat",
						prompt: "Where?",
						required: true,
						widget: { type: "custom", data: { id: "seat_picker", props: {} } },
					},
				]),
			],
		]);
		expect(screen.getByText("This app can’t show “seat_picker”.")).toBeDefined();
		await click(screen.getByText("Submit"));
		await expect(answered(back)).resolves.toEqual({
			type: "submitted",
			data: {
				answers: [
					{ question_id: "day", outcome: { type: "skipped" } },
					{ question_id: "seat", outcome: { type: "unsupported" } },
				],
			},
		});
	});

	it("offers only to tell the agent when it can draw nothing, a newer widget included", async () => {
		const back = backend();
		await mount(back);
		await push(back, [
			[
				1,
				asked([
					{ id: "level", prompt: "How loud?", required: true, widget: { type: "slider", data: {} } },
					{ id: "seat", prompt: "Where?", required: true, widget: { type: "custom", data: { id: "map", props: {} } } },
				]),
			],
		]);
		expect(screen.getByText("This app can’t show the agent’s question.")).toBeDefined();
		expect(screen.queryByText("Submit")).toBeNull();
		await click(screen.getByText("Tell the agent"));
		await expect(answered(back)).resolves.toEqual({
			type: "submitted",
			data: {
				answers: [
					{ question_id: "level", outcome: { type: "unsupported" } },
					{ question_id: "seat", outcome: { type: "unsupported" } },
				],
			},
		});
	});

	it("dismisses a form, and shows why an answer was refused", async () => {
		const back = backend({
			"/inputs/c1": () => json({ error: { code: "invalid_request", message: "Invalid answer: no" } }, 400),
		});
		await mount(back);
		await push(back, [[1, asked([{ id: "ok", prompt: "Proceed?", required: true, widget: { type: "confirm" } }])]]);
		await click(screen.getByText("Dismiss"));
		await expect(answered(back)).resolves.toEqual({ type: "declined", data: {} });
		expect(screen.getByText(/Invalid answer: no/)).toBeDefined();
	});
});
