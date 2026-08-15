import {
	type CliRenderer,
	createCliRenderer,
	type SelectOption,
} from "@opentui/core";

import { restartServer } from "../../cli/src/server-command";
import { abortableSleep } from "../../shared/src/abortable-sleep";
import { TuiApp } from "./app";
import { HarnezClient, type SessionSummary } from "./client";
import { WizardView } from "./components/wizard";
import { createTuiStore } from "./store";

const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

export async function runTui(
	options: {
		sessionId?: string;
		pickSession?: boolean;
		/** Resolved off the startup path; see the caller in the CLI entry point. */
		notice?: Promise<{ full: string; short: string } | undefined>;
	} = {},
): Promise<void> {
	const client = new HarnezClient();
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
	let store = createTuiStore(sessionId);
	let controller = new AbortController();
	let stopped = false;
	let clearInProgress: Promise<void> | undefined;
	const app = new TuiApp(
		renderer,
		store,
		(command) => client.send(sessionId, command),
		async () => {
			if (clearInProgress) return clearInProgress;
			clearInProgress = (async () => {
				// Do not abandon the current session unless its replacement was created.
				const previousSessionId = sessionId;
				const nextSessionId = await client.createSession(store.getState().pwd);
				if (stopped) return;
				await client
					.send(previousSessionId, { type: "abort" })
					.catch(() => undefined);
				controller.abort();
				sessionId = nextSessionId;
				store = createTuiStore(sessionId);
				app.replaceStore(store);
				controller = new AbortController();
				void streamWithReconnect(sessionId, store, controller);
			})();
			try {
				await clearInProgress;
			} finally {
				clearInProgress = undefined;
			}
		},
		async () => {
			await restartServer();
		},
	);
	/** Reconnect a specific session; old streams can never write into a new one. */
	async function streamWithReconnect(
		id: string,
		targetStore: ReturnType<typeof createTuiStore>,
		streamController: AbortController,
	): Promise<void> {
		let cursor = 0;
		let attempt = 0;
		while (!streamController.signal.aborted) {
			try {
				await client.stream(id, {
					signal: streamController.signal,
					onEvent: targetStore.getState().apply,
					onCursor: (seq) => {
						cursor = seq;
					},
					onConnected: () => {
						attempt = 0;
						for (const command of [
							{ type: "list-skills" },
							{ type: "list-prompts" },
						] as const)
							void client.send(id, command).catch(() => undefined);
					},
					from: cursor,
				});
			} catch (error) {
				if (streamController.signal.aborted) return;
				if (attempt === 0)
					targetStore.getState().apply({
						type: "error",
						message: `connection lost, reconnecting: ${
							error instanceof Error ? error.message : String(error)
						}`,
					});
			}
			if (streamController.signal.aborted) return;
			await abortableSleep(
				Math.min(
					RECONNECT_BASE_DELAY_MS * 2 ** attempt,
					RECONNECT_MAX_DELAY_MS,
				),
				streamController.signal,
			);
			attempt++;
		}
	}

	void streamWithReconnect(sessionId, store, controller);
	/** Guarded on shutdown so a late answer never touches a torn-down renderer. */
	void options.notice
		?.then((text) => {
			if (text && !stopped) app.setNotice(text);
		})
		.catch(() => undefined);
	await new Promise<void>((resolve) => renderer.once("destroy", resolve));
	stopped = true;
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
				options: sessions.map((session): SelectOption => ({
					name: session.title ?? session.workspace ?? "Unknown workspace",
					description: `${session.title !== null ? `${session.workspace ?? "Unknown workspace"} · ` : ""}${new Date(session.createdAt).toLocaleString()} · ${session.id}`,
					value: session.id,
				})),
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
