import { describe, expect, test } from "bun:test";
import { TuiPluginHost, type TuiPlugin } from "../src/plugins";
import { createTuiStore } from "../src/store";

describe("TUI plugin host", () => {
	test("projects state to plugins and dispatches registered commands", async () => {
		const store = createTuiStore("session");
		const states: string[] = [];
		const sent: string[] = [];
		const plugin: TuiPlugin = {
			id: "sample",
			commands: [
				{
					name: "/sample",
					description: "Sample command",
					run: (_, api) => api.send({ type: "abort" }),
				},
			],
			mount: (api) => api.subscribe((state) => states.push(state.status)),
		};
		const host = new TuiPluginHost(store, async (command) => {
			sent.push(command.type);
		}, [plugin]);
		try {
			store.getState().apply({ type: "status", text: "running" });
			expect(await host.run("/sample later")).toBe(true);
			expect(states).toEqual(["running"]);
			expect(sent).toEqual(["abort"]);
		} finally {
			host.destroy();
		}
	});

	test("rejects duplicate command names", () => {
		const store = createTuiStore("session");
		expect(
			() =>
				new TuiPluginHost(store, async () => {}, [
					{ id: "one", commands: [command("/same")] },
					{ id: "two", commands: [command("/same")] },
				]),
		).toThrow("duplicate TUI command /same: one, two");
	});
});

function command(name: string) {
	return { name, description: name, run: () => {} };
}
