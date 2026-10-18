"use client";

import type { ReasoningMessagePartProps, ToolCallMessagePartProps } from "@assistant-ui/react";
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePartPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useSessionState } from "@subako-ai/react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext } from "react";
import remarkGfm from "remark-gfm";
import { SubakoInputForm, type WidgetRenderers } from "./input-form.js";
import type { SubakoSession } from "./runtime.js";
import { useSubakoRuntime } from "./runtime.js";

/**
 * Enough style to read a conversation with no setup at all. Every surface names
 * its own color and its own background, so the chat is legible on a page of any
 * color rather than inheriting half of one. The eight custom properties are the
 * theming seam: light by default, dark when the browser asks for it, and an app
 * that sets them on `.subako-chat` overrides both. `className` is where an app
 * takes the rest over.
 *
 * Every rule sits in the `subako` cascade layer. A rule of the app's own that
 * names a class therefore wins at any specificity and from anywhere in the
 * page; an app whose CSS is layered itself names `subako` in its layer order,
 * where it wants the chat's defaults to sit. The guard after the layer keeps a
 * page's reset out of the chat's own elements.
 */
const STYLE = `
@layer subako {
.subako-chat { --subako-bg: #ffffff; --subako-fg: #18181b; --subako-muted: #52525b; --subako-accent: #2563eb;
	--subako-accent-fg: #ffffff; --subako-border: #d4d4d8; --subako-surface: #f4f4f5; --subako-error: #b91c1c;
	color-scheme: light dark; display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px;
	font: 14px/1.5 system-ui, sans-serif; background: var(--subako-bg); color: var(--subako-fg); }
@media (prefers-color-scheme: dark) {
	.subako-chat { --subako-bg: #18181b; --subako-fg: #f4f4f5; --subako-muted: #a1a1aa; --subako-accent: #3b82f6;
		--subako-accent-fg: #ffffff; --subako-border: #3f3f46; --subako-surface: #27272a; --subako-error: #fca5a5; }
}
.subako-viewport { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
	gap: 8px; padding: 8px; }
.subako-message { max-width: 42em; padding: 8px 12px; border-radius: 12px; white-space: normal;
	overflow-wrap: anywhere; }
.subako-message p { margin: 0 0 4px; }
.subako-message p:last-child { margin-bottom: 0; }
.subako-user { align-self: flex-end; background: var(--subako-accent); color: var(--subako-accent-fg); }
.subako-assistant { align-self: flex-start; background: var(--subako-surface); color: var(--subako-fg); }
.subako-thinking { margin: 4px 0; padding: 4px 8px; border-left: 2px solid var(--subako-border);
	color: var(--subako-muted); font-style: italic; white-space: pre-wrap; }
/* The assistant's markdown: enough type to read headings, lists, code and tables inside a bubble. */
.subako-markdown > :first-child { margin-top: 0; }
.subako-markdown > :last-child { margin-bottom: 0; }
.subako-markdown p, .subako-markdown ul, .subako-markdown ol, .subako-markdown pre, .subako-markdown blockquote,
	.subako-markdown table { margin: 0 0 6px; }
.subako-markdown h1, .subako-markdown h2, .subako-markdown h3, .subako-markdown h4, .subako-markdown h5,
	.subako-markdown h6 { margin: 8px 0 4px; font-size: 1em; font-weight: 600; line-height: 1.3; }
.subako-markdown h1 { font-size: 1.25em; }
.subako-markdown h2 { font-size: 1.15em; }
.subako-markdown h3 { font-size: 1.05em; }
.subako-markdown ul, .subako-markdown ol { padding-left: 1.5em; }
.subako-markdown ul { list-style: disc; }
.subako-markdown ol { list-style: decimal; }
.subako-markdown li { margin: 2px 0; }
.subako-markdown a { color: var(--subako-accent); text-decoration: underline; }
.subako-markdown code { padding: 1px 4px; border-radius: 4px; background: var(--subako-bg);
	font-family: ui-monospace, monospace; font-size: 12px; }
.subako-markdown pre { padding: 6px 8px; border-radius: 6px; background: var(--subako-bg); white-space: pre-wrap;
	overflow-wrap: anywhere; }
.subako-markdown pre code { padding: 0; background: none; }
.subako-markdown blockquote { padding: 0 0 0 8px; border-left: 2px solid var(--subako-border);
	color: var(--subako-muted); }
.subako-markdown table { border-collapse: collapse; font-size: 13px; }
.subako-markdown th, .subako-markdown td { padding: 2px 6px; border: 1px solid var(--subako-border);
	text-align: left; }
.subako-markdown hr { margin: 8px 0; border: 0; border-top: 1px solid var(--subako-border); }
.subako-markdown img { max-width: 100%; height: auto; border-radius: 6px; }
.subako-writing { display: block; margin-top: 4px; color: var(--subako-muted); font-size: 10px; }
.subako-tool { margin: 4px 0; padding: 6px 8px; border: 1px solid var(--subako-border); border-radius: 8px;
	background: var(--subako-bg); color: var(--subako-fg); }
/* The row is the fold's handle: the name, the status, and a chevron that turns when it is open. */
.subako-tool-summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; }
.subako-tool-summary::-webkit-details-marker { display: none; }
.subako-tool-summary::after { content: "›"; margin-left: auto; color: var(--subako-muted); font-size: 16px;
	line-height: 1; transition: transform 0.15s; }
.subako-tool-fold[open] > .subako-tool-summary::after { transform: rotate(90deg); }
.subako-tool-name { font-weight: 600; font-family: ui-monospace, monospace; }
.subako-tool-status { color: var(--subako-muted); font-size: 12px; }
.subako-tool-label { margin-top: 6px; color: var(--subako-muted); font-size: 11px; text-transform: uppercase;
	letter-spacing: 0.04em; }
/* The arguments and the result wrap instead of scrolling sideways: a chat panel is narrow. */
.subako-tool pre { margin: 4px 0 0; padding: 4px 6px; border-radius: 6px; background: var(--subako-surface);
	color: var(--subako-fg); font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap;
	overflow-wrap: anywhere; }
.subako-tool-result[data-error] { color: var(--subako-error); }
.subako-approval { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 4px 6px;
	border-radius: 6px; background: var(--subako-surface); color: var(--subako-fg); }
.subako-approval button { padding: 2px 10px; border: 1px solid var(--subako-border); border-radius: 6px;
	background: var(--subako-bg); color: var(--subako-fg); font: inherit; cursor: pointer; }
.subako-inputs { display: flex; flex-direction: column; gap: 8px; padding: 0 8px; }
.subako-input-form { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 8px 10px;
	border: 1px solid var(--subako-border); border-radius: 8px; background: var(--subako-surface);
	color: var(--subako-fg); }
.subako-input-question { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; border: 0;
	min-width: 0; }
.subako-input-prompt { padding: 0; font-weight: 600; }
.subako-input-options { display: flex; flex-direction: column; gap: 2px; }
.subako-input-option { display: flex; align-items: baseline; gap: 6px; }
.subako-input-hint { color: var(--subako-muted); font-size: 12px; }
.subako-input-text { padding: 4px 6px; border: 1px solid var(--subako-border); border-radius: 6px;
	background: var(--subako-bg); color: var(--subako-fg); font: inherit; }
.subako-input-actions { display: flex; gap: 8px; }
.subako-input-actions button { padding: 2px 12px; border: 1px solid var(--subako-border); border-radius: 6px;
	background: var(--subako-bg); color: var(--subako-fg); font: inherit; cursor: pointer; }
.subako-input-actions button:disabled { opacity: 0.5; cursor: default; }
.subako-input-error { color: var(--subako-error); font-size: 12px; }
.subako-composer { display: flex; gap: 8px; padding: 8px; border-top: 1px solid var(--subako-border);
	background: var(--subako-bg); color: var(--subako-fg); }
.subako-input { flex: 1 1 auto; resize: none; padding: 6px 8px; border: 1px solid var(--subako-border);
	border-radius: 8px; background: var(--subako-bg); color: var(--subako-fg); font: inherit; }
.subako-input::placeholder { color: var(--subako-muted); }
.subako-composer button { padding: 4px 14px; border: 1px solid var(--subako-border); border-radius: 8px;
	background: var(--subako-bg); color: var(--subako-fg); font: inherit; cursor: pointer; }
.subako-composer button:disabled { opacity: 0.5; cursor: default; }
}
/* Element rules from outside — a reset's star and button, an app's own pre — stop at the chat's own
   elements. These guards sit in no layer, with the specificity of two element names, and ask the
   cascade to skip every unlayered declaration and take the layered ones: a reset, which names no
   class, loses to them, and a rule that names a class outranks them. A tool UI the app draws is
   left alone, and so is the root, where the app's own classes go. */
div:where(.subako-chat) div:where(.subako-viewport, .subako-message, .subako-thinking, .subako-tool,
	.subako-tool-label, .subako-approval, .subako-markdown),
div:where(.subako-chat) :where(.subako-markdown) :is(h1, h2, h3, h4, h5, h6, p, ul, ol, li, a, code, pre, blockquote,
	table, th, td, hr, img),
div:where(.subako-chat) details:where(.subako-tool-fold),
div:where(.subako-chat) summary:where(.subako-tool-summary),
div:where(.subako-chat) span:where(.subako-tool-name, .subako-tool-status, .subako-writing),
div:where(.subako-chat) pre:where(.subako-tool-args, .subako-tool-result),
div:where(.subako-chat) :where(.subako-approval, .subako-composer, .subako-input-actions) > button,
div:where(.subako-chat) div:where(.subako-inputs, .subako-input-options, .subako-input-hint, .subako-input-actions,
	.subako-input-error),
div:where(.subako-chat) :where(.subako-input-form):is(form, div),
div:where(.subako-chat) fieldset:where(.subako-input-question),
div:where(.subako-chat) legend:where(.subako-input-prompt),
div:where(.subako-chat) label:where(.subako-input-option),
div:where(.subako-chat) :where(.subako-input-text):is(input, textarea),
div:where(.subako-chat) form:where(.subako-composer),
div:where(.subako-chat) textarea:where(.subako-input),
div:where(.subako-chat) textarea:where(.subako-input)::placeholder { all: revert-layer; }
`;

/** A `thinking` block: shown, quietly, rather than hidden the way assistant-ui hides it by default. */
function Reasoning({ text }: ReasoningMessagePartProps): ReactNode {
	return <div className="subako-thinking">{text}</div>;
}

/** GFM on top of CommonMark: tables, strikethrough, task lists and bare URLs, which a model writes unasked. */
const REMARK_PLUGINS = [remarkGfm];

/** react-markdown hands each element its node as well; a link opens beside the app rather than leaving it. */
const MARKDOWN_COMPONENTS = {
	a: ({ node: _node, ...rest }: ComponentProps<"a"> & { readonly node?: unknown }) => (
		<a {...rest} target="_blank" rel="noreferrer" />
	),
};

/**
 * The assistant's body as markdown, which is what a model writes. The text
 * arrives whole, so nothing is animated; a fenced block is a plain `pre` and
 * `code`, and `components.Text` is where a highlighter goes. While the run is
 * still writing, a mark follows the text, the way assistant-ui's own text
 * part shows one.
 */
function Markdown(): ReactNode {
	return (
		<>
			<MarkdownTextPrimitive
				className="subako-markdown"
				remarkPlugins={REMARK_PLUGINS}
				components={MARKDOWN_COMPONENTS}
				smooth={false}
			/>
			<MessagePartPrimitive.InProgress>
				<span className="subako-writing">●</span>
			</MessagePartPrimitive.InProgress>
		</>
	);
}

/** A result is text by the time it reaches here; an app's own tool UI may answer with anything. */
const resultText = (result: unknown): string => (typeof result === "string" ? result : JSON.stringify(result));

/** JSON laid out to read, when the text is JSON; anything else is shown as it came. */
function laidOut(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : text;
	} catch {
		return text;
	}
}

/** Whether the server is still waiting on the person: no decision and no cancellation are recorded. */
const awaiting = (approval: ToolCallMessagePartProps["approval"]): boolean =>
	approval !== undefined && approval.approved === undefined && approval.resolution === undefined;

/** What the approval prompt reads off a tool-call part: the call's name, its approval, and the answer. */
export type SubakoToolApprovalProps = Pick<ToolCallMessagePartProps, "toolName" | "approval" | "respondToApproval">;

/**
 * The approval prompt of the chat's own tool row, for a tool UI the app draws
 * itself: Allow and Deny while the server waits on the person, and nothing
 * once there is an answer or the run was canceled. Spread the tool call's
 * props into it; the answer reaches `resolveApproval` the same way.
 */
export function SubakoToolApproval({ toolName, approval, respondToApproval }: SubakoToolApprovalProps): ReactNode {
	if (!awaiting(approval)) {
		return null;
	}
	return (
		<div className="subako-approval">
			<span>Run {toolName}?</span>
			<button type="button" onClick={() => void respondToApproval({ approved: true })}>
				Allow
			</button>
			<button type="button" onClick={() => void respondToApproval({ approved: false })}>
				Deny
			</button>
		</div>
	);
}

/** The one word the folded row says about the call. */
function statusOf(props: ToolCallMessagePartProps): string {
	if (awaiting(props.approval)) {
		return "needs approval";
	}
	if (props.approval?.approved === false) {
		return "denied";
	}
	if (props.result === undefined) {
		return "running";
	}
	return props.isError === true ? "failed" : "done";
}

/**
 * A tool call folded to its name and its status. Opening it shows the
 * arguments and the result, as JSON laid out to read. The approval prompt
 * sits outside the fold, so a closed row still asks.
 */
function ToolCall(props: ToolCallMessagePartProps): ReactNode {
	const { toolName, args, result, isError } = props;
	return (
		<div className="subako-tool" data-testid={`tool-${toolName}`}>
			<details className="subako-tool-fold">
				<summary className="subako-tool-summary">
					<span className="subako-tool-name">{toolName}</span>
					<span className="subako-tool-status">{statusOf(props)}</span>
				</summary>
				<div className="subako-tool-label">Input</div>
				<pre className="subako-tool-args">{JSON.stringify(args, null, 2)}</pre>
				{result === undefined ? null : (
					<>
						<div className="subako-tool-label">Output</div>
						<pre className="subako-tool-result" data-error={isError === true ? "" : undefined}>
							{laidOut(resultText(result))}
						</pre>
					</>
				)}
			</details>
			<SubakoToolApproval {...props} />
		</div>
	);
}

/** The components an assistant message's parts are drawn with, as `MessagePrimitive.Parts` takes them. */
type PartComponents = NonNullable<ComponentProps<typeof MessagePrimitive.Parts>["components"]>;

/** The app's part components, handed down from `<SubakoChat>` to every assistant message. */
const PartsContext = createContext<PartComponents | undefined>(undefined);

/**
 * The chat's own parts under the app's: its markdown body, its reasoning block
 * and its tool row stay wherever the app names nothing, so a `by_name` keeps
 * the row for every other tool, and an `Override` takes all of them. A
 * `ChainOfThought` draws the reasoning and the tool calls itself.
 */
function partsOf(theirs: PartComponents | undefined): PartComponents {
	if (theirs?.ChainOfThought !== undefined) {
		return { Text: Markdown, ...theirs };
	}
	const tools = theirs?.tools;
	return {
		Text: Markdown,
		Reasoning,
		...theirs,
		tools: tools !== undefined && "Override" in tools ? tools : { Fallback: ToolCall, ...tools },
	};
}

function UserMessage(): ReactNode {
	return (
		<MessagePrimitive.Root className="subako-message subako-user">
			<MessagePrimitive.Parts />
		</MessagePrimitive.Root>
	);
}

function AssistantMessage(): ReactNode {
	const theirs = useContext(PartsContext);
	return (
		<MessagePrimitive.Root className="subako-message subako-assistant">
			{/* A tool the app registered a UI for keeps it; everything else falls back to the row above. */}
			<MessagePrimitive.Parts components={partsOf(theirs)} />
		</MessagePrimitive.Root>
	);
}

export interface SubakoChatProps {
	/** The connection from `useSession`, which is `null` until its effect has opened one. */
	readonly session: SubakoSession | null;
	/** Added to the root element, for an app that styles the thread itself. */
	readonly className?: string;
	/**
	 * The components an assistant message's parts are drawn with, as
	 * `MessagePrimitive.Parts` takes them: `Text` for the body, in place of the
	 * chat's own markdown; `tools` for the tool calls, whose `Fallback` replaces
	 * the chat's own row and whose `by_name` replaces it for the tools named.
	 * The chat's body, reasoning block and tool row stay wherever nothing is
	 * named.
	 */
	readonly components?: PartComponents;
	/**
	 * The page's CSP nonce, for a page whose `style-src-elem` names one. Without
	 * it the browser drops the chat's own stylesheet and the thread renders
	 * unstyled; a page with no such policy needs nothing here.
	 */
	readonly nonce?: string;
	/**
	 * The custom widgets this app draws in a form the agent puts through
	 * `builtin:ask_user`, by widget id. A widget with no renderer here lets the
	 * person tell the agent the app cannot show it.
	 */
	readonly widgets?: WidgetRenderers;
	/** Rendered inside the runtime, which is where a tool UI registers itself. */
	readonly children?: ReactNode;
}

/**
 * One session as a working chat: the transcript, the tool calls with their
 * approvals, the forms the agent puts to the person, a composer, and a stop button while a run is under way. The
 * session is the app's own, so the chat opens no second connection; until it
 * has one the thread is empty and the composer is disabled. It exists for the
 * first ten minutes; an app that wants its own thread keeps `useSubakoRuntime`
 * and builds the rest from assistant-ui's primitives.
 */
export function SubakoChat({ session, className, components, nonce, widgets, children }: SubakoChatProps): ReactNode {
	const runtime = useSubakoRuntime(session);
	const state = useSessionState(session);
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<style nonce={nonce}>{STYLE}</style>
			{children}
			<PartsContext.Provider value={components}>
				<ThreadPrimitive.Root className={className === undefined ? "subako-chat" : `subako-chat ${className}`}>
					<ThreadPrimitive.Viewport className="subako-viewport">
						<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
					</ThreadPrimitive.Viewport>
					{session === null || state === null || state.inputs.length === 0 ? null : (
						<div className="subako-inputs">
							{state.inputs.map((input) => (
								<SubakoInputForm
									key={`${input.call_id}:${input.seq}`}
									input={input}
									widgets={widgets}
									onAnswer={(answer) => session.answerInput(input.call_id, answer)}
								/>
							))}
						</div>
					)}
					<ComposerPrimitive.Root className="subako-composer">
						<ComposerPrimitive.Input className="subako-input" rows={1} placeholder="Message the agent" />
						<ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
						{state?.isRunning === true ? <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel> : null}
					</ComposerPrimitive.Root>
				</ThreadPrimitive.Root>
			</PartsContext.Provider>
		</AssistantRuntimeProvider>
	);
}
