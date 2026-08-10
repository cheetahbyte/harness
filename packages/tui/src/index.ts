import { createCliRenderer } from "@opentui/core";
import { TuiApp } from "./app";
import { HarnessClient } from "./client";
import { createTuiStore } from "./store";

const client = new HarnessClient();
const sessionId = process.argv[2] ?? (await client.createSession());
const store = createTuiStore(sessionId);
const controller = new AbortController();
const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
const app = new TuiApp(renderer, store, (command) =>
	client.send(sessionId, command),
);
void client
	.stream(
		sessionId,
		store.getState().apply,
		controller.signal,
		() => void client.send(sessionId, { type: "list-skills" }),
	)
	.catch((error) => {
		if (!controller.signal.aborted)
			store.getState().apply({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
	});
await new Promise<void>((resolve) => renderer.once("destroy", resolve));
app.destroy();
controller.abort();
