import {
	type CliRenderer,
	createCliRenderer,
	type SelectOption,
} from "@opentui/core";
import { abortableSleep } from "../../shared/src/abortable-sleep";
import { TuiApp } from "./app";
import { HarnessClient, type SessionSummary } from "./client";
import { WizardView } from "./components/wizard";
import { createTuiStore } from "./store";

const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

export async function runTui(
	options: { sessionId?: string; pickSession?: boolean } = {},
): Promise<void> {
	const client = new HarnessClient();
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		targetFps: 30,
	});
	let sessionId: string;
	try {
		sessionId =
			options.sessionId ??
			(options.pickSession
				? await pickSession(renderer, await client.listSessions())
				: undefined) ??
			(await client.createSession());
	} catch (error) {
		renderer.destroy();
		throw error;
	}
	const store = createTuiStore(sessionId);
	const controller = new AbortController();
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

export function pickSession(
	renderer: CliRenderer,
	sessions: SessionSummary[],
): Promise<string | undefined> {
	const wizard = new WizardView(renderer);
	renderer.root.add(wizard.root);
	return new Promise((resolve) => {
		const finish = (sessionId?: string) => {
			wizard.hide();
			wizard.destroy();
			renderer.root.remove(wizard.root);
			resolve(sessionId);
		};
		wizard.show(
			{
				kind: "select",
				title: "Resume session",
				options: sessions.map(
					(session): SelectOption => ({
						name: session.title ?? session.workspace ?? "Unknown workspace",
						description: `${session.title !== null ? `${session.workspace ?? "Unknown workspace"} · ` : ""}${new Date(session.createdAt).toLocaleString()} · ${session.id}`,
						value: session.id,
					}),
				),
				searchable: true,
				descriptionLayout: "inline",
			},
			{
				select: (option) => finish(option.value as string),
				cancel: () => finish(),
			},
		);
	});
}

if (import.meta.main)
	await runTui(
		process.argv[2] === undefined ? {} : { sessionId: process.argv[2] },
	);
