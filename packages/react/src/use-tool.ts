"use client";

import type { ToolClient, ToolDefinition } from "@subako-ai/sdk";
import { type RefObject, useEffect } from "react";

/** The attribute a `target` element carries while a call to its tool is running. */
export const TOOL_ATTRIBUTE = "data-subako-tool";

/** What that attribute says while the call is in flight. */
export const TOOL_RUNNING = "running";

const isRunning = (client: ToolClient, name: string): boolean =>
	client.state.calls.some((call) => call.tool === name && call.phase === "running");

export interface UseToolOptions<E extends HTMLElement = HTMLElement> {
	/** An element that carries `data-subako-tool="running"` while a call to this tool is in flight. */
	readonly target?: RefObject<E | null>;
}

/**
 * Declares one tool for as long as the component is mounted; the client
 * reconciles the set, one update per tick. A `null` client is the one
 * `useToolClient` has yet to create, and declares nothing.
 */
export function useTool<A = unknown, E extends HTMLElement = HTMLElement>(
	client: ToolClient | null,
	toolName: string,
	tool: ToolDefinition<A>,
	options: UseToolOptions<E> = {},
): void {
	const target = options.target;
	useEffect(() => {
		client?.addTool(toolName, tool);
	}, [client, toolName, tool]);
	// The declaration outlives every re-render; only unmounting, or a new name, withdraws it.
	useEffect(() => {
		if (client === null) {
			return undefined;
		}
		return () => client.removeTool(toolName);
	}, [client, toolName]);
	useEffect(() => {
		if (client === null || target === undefined) {
			return undefined;
		}
		const paint = (): void => {
			const element = target.current;
			if (element === null) {
				return;
			}
			if (isRunning(client, toolName)) {
				element.setAttribute(TOOL_ATTRIBUTE, TOOL_RUNNING);
			} else {
				element.removeAttribute(TOOL_ATTRIBUTE);
			}
		};
		paint();
		const stop = client.subscribe(paint);
		return () => {
			stop();
			target.current?.removeAttribute(TOOL_ATTRIBUTE);
		};
	}, [client, toolName, target]);
}
