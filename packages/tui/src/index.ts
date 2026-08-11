import { createCliRenderer } from "@opentui/core";
import { abortableSleep } from "../../shared/src/abortable-sleep";
import { TuiApp } from "./app";
import { HarnessClient } from "./client";
import { createTuiStore } from "./store";

const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

export async function runTui(
	options: { sessionId?: string } = {},
): Promise<void> {
	const client = new HarnessClient();
	const sessionId = options.sessionId ?? (await client.createSession());
	const store = createTuiStore(sessionId);
	const controller = new AbortController();
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		targetFps: 30,
	});
	const app = new TuiApp(renderer, store, (command) =>
		client.send(sessionId, command),
	);
	/**
	 * The event stream carries every bit of agent output, so a drop must not be
	 * terminal. Reconnect with backoff, resuming after the last cursor applied so
	 * the transcript neither duplicates nor loses events. Only the first failure of
	 * an outage is reported, to keep retries quiet.
	 */
	async function streamWithReconnect(): Promise<void> {
		let cursor = 0;
		let attempt = 0;
		while (!controller.signal.aborted) {
			try {
				await client.stream(sessionId, {
					signal: controller.signal,
					onEvent: store.getState().apply,
					onCursor: (seq) => {
						cursor = seq;
					},
					onConnected: () => {
						attempt = 0;
						void client
							.send(sessionId, { type: "list-skills" })
							.catch(() => undefined);
					},
					from: cursor,
				});
			} catch (error) {
				if (controller.signal.aborted) return;
				if (attempt === 0)
					store.getState().apply({
						type: "error",
						message: `connection lost, reconnecting: ${
							error instanceof Error ? error.message : String(error)
						}`,
					});
			}
			if (controller.signal.aborted) return;
			await abortableSleep(
				Math.min(
					RECONNECT_BASE_DELAY_MS * 2 ** attempt,
					RECONNECT_MAX_DELAY_MS,
				),
				controller.signal,
			);
			attempt++;
		}
	}

	void streamWithReconnect();
	await new Promise<void>((resolve) => renderer.once("destroy", resolve));
	app.destroy();
	controller.abort();
}

if (import.meta.main)
	await runTui(
		process.argv[2] === undefined ? {} : { sessionId: process.argv[2] },
	);
