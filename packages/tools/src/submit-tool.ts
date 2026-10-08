import type { ToolDefinition } from "@subako-ai/sdk";
import type { FormReading } from "./form-tool.js";
import type { JsonSchema } from "./schema.js";

/** What an adapter or an app contributes to a `submitTool`: the send, and the form's own answer. */
export interface SubmitSource {
	/** Sends the form. `false` says the form refused it — its own validation, most often. */
	submit(): boolean | void | Promise<boolean | void>;
	/** Read only when the form refused, so its `errors` say why; a form that went through may be gone. */
	read?(): FormReading;
}

export interface SubmitToolSpec extends SubmitSource {
	/** What submitting this form does, as the model reads it. */
	readonly description?: string;
}

const DEFAULT_DESCRIPTION = "Submit this form.";

const NO_ARGUMENTS: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

const REFUSED = "the form refused it";

/** The refusal, with whatever the form was unhappy about spelled out for the model to correct. */
function refusal(reading: FormReading | undefined): string {
	const errors = reading?.errors;
	if (errors === undefined) {
		return REFUSED;
	}
	const said = Object.entries(errors).map(([name, message]) => `${name}: ${message}`);
	return said.length === 0 ? REFUSED : `${REFUSED} — ${said.join("; ")}`;
}

/**
 * Sending a form the model has filled in, as its own tool: the app declares it beside the form
 * tool only where the model may send, so a form the person alone submits simply has no submit.
 * It takes no arguments, which is what keeps a strict schema from inventing one.
 */
export function submitTool(spec: SubmitToolSpec): ToolDefinition {
	return {
		description: spec.description ?? DEFAULT_DESCRIPTION,
		parameters: NO_ARGUMENTS,
		execute: async () => {
			const went = await spec.submit();
			if (went === false) {
				return { text: refusal(spec.read?.()), is_error: true };
			}
			return "The form was submitted.";
		},
	};
}
