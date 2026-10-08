import { useTool } from "@subako-ai/react";
import { formTool, fromFormElement } from "@subako-ai/tools";
import { type ReactNode, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { useAgent } from "../agent";
import { type Settings, type Theme, useApp } from "../app";

const THEMES: readonly Theme[] = ["light", "dark", "system"];

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);

/** The no-library path: a plain form the adapter reads, and an `apply` that writes React state. */
export function SettingsPage(): ReactNode {
	const app = useApp();
	const { client } = useAgent();
	const formRef = useRef<HTMLFormElement>(null);

	const apply = useCallback(
		(values: Record<string, unknown>) => {
			const name = values["display_name"];
			const theme = values["theme"];
			const next: Partial<Settings> = {
				...(typeof name === "string" ? { display_name: name } : {}),
				...(isTheme(theme) ? { theme } : {}),
			};
			// `formTool` reads the form back as soon as `apply` returns, and the inputs
			// only carry these values once React has committed them.
			flushSync(() => app.updateSettings(next));
		},
		[app],
	);

	// `fromFormElement` is a reader: it describes the form from the controls themselves, and it
	// reads them when the client asks, so this can be built before the form reaches the DOM.
	// The `apply` beside it is the app's, and commits so the read that follows sees the fill.
	useTool(
		client,
		"fill_settings",
		formTool({
			...fromFormElement(formRef),
			apply,
			description: "Fill in the settings form: the display name shown in the header, and the theme.",
		}),
		{ target: formRef },
	);

	return (
		<section>
			<div className="head">
				<h1>Settings</h1>
			</div>
			<form ref={formRef} className="form">
				<label htmlFor="display_name">Display name</label>
				<input
					id="display_name"
					name="display_name"
					value={app.settings.display_name}
					onChange={(event) => app.updateSettings({ display_name: event.target.value })}
				/>

				<label htmlFor="theme">Theme</label>
				<select
					id="theme"
					name="theme"
					value={app.settings.theme}
					onChange={(event) => apply({ theme: event.target.value })}
				>
					{THEMES.map((theme) => (
						<option key={theme} value={theme}>
							{theme}
						</option>
					))}
				</select>
			</form>
			<p className="hint">Nothing to submit: the form is the setting.</p>
		</section>
	);
}
