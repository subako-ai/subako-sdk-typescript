// The chat example's backend: the agent this example publishes, and nothing
// else. The session routes and the bootstrap are examples/shared/server.mjs's.
//
//   node examples/chat/server.mjs
import { SubakoClient } from "@subako-ai/sdk";
import { credentials, serve } from "../shared/server.mjs";

const { env, agentConfig } = credentials();

const subako = new SubakoClient({
	baseUrl: env.SUBAKO_BASE_URL,
	apiKey: env.SUBAKO_API_KEY,
	workspaceId: env.SUBAKO_WORKSPACE_ID,
});

const SYSTEM_PROMPT = `You are a helpful assistant in a chat. Answer in the language the person writes in.
Write markdown where it helps: short paragraphs, a list for steps, a code block for code, a table
for a comparison. Keep it brief.`;

serve({
	subako,
	agent: {
		name: "example-chat",
		model: agentConfig.model,
		config: () => ({ system_prompt: SYSTEM_PROMPT }),
	},
});
