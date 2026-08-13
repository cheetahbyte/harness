import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { authPromptAnswer } from "./auth-prompt";
import { JsonCredentialStore } from "./provider";
import { globalHarnezPath } from "./settings-store";

if (process.argv[2] !== "codex") throw new Error("usage: bun run auth codex");
registerBunOAuthFlows();
const credentials = new JsonCredentialStore(globalHarnezPath("auth.json"));
const models = builtinModels({ credentials });
const terminal = createInterface({ input, output });
try {
	await models.login("openai-codex", "oauth", {
		prompt: async (prompt: AuthPrompt) =>
			authPromptAnswer(
				prompt,
				await terminal.question(
					`${prompt.message}${prompt.type === "select" ? ` [${prompt.options.map((option) => `${option.label}=${option.id}`).join(", ")}]` : ""}${"placeholder" in prompt && prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `,
				),
			),
		notify: (event: AuthEvent) => {
			if (event.type === "auth_url")
				console.log(`Open this URL to sign in:\n${event.url}`);
			else if (event.type === "device_code")
				console.log(
					`Open ${event.verificationUri} and enter ${event.userCode}`,
				);
			else console.log(event.message);
		},
	});
	console.log("Codex subscription authentication saved.");
} finally {
	terminal.close();
}
