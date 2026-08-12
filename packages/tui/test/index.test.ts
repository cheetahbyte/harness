import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { pickSession } from "../src/index";

const sessions = Array.from({ length: 6 }, (_, index) => ({
	id: `session-${index + 1}`,
	createdAt: `2026-08-12T12:00:0${index}.000Z`,
	workspace: `/tmp/project-${index + 1}`,
	title: null,
}));

test("shows the title and workspace for titled sessions", async () => {
	const view = await createTestRenderer({
		width: 100,
		height: 20,
		kittyKeyboard: true,
	});
	try {
		const selected = pickSession(view.renderer, [
			{
				id: "session-title",
				createdAt: "2026-08-12T12:00:00.000Z",
				workspace: "/tmp/project",
				title: "Add session names",
			},
		]);
		await view.flush();
		const frame = view.captureCharFrame();
		expect(frame).toContain("Add session names");
		expect(frame).toContain("/tmp/project");
		view.mockInput.pressEnter();
		await expect(selected).resolves.toBe("session-title");
	} finally {
		view.renderer.destroy();
	}
});

test("falls back to the workspace when a session has no title", async () => {
	const view = await createTestRenderer({
		width: 100,
		height: 20,
		kittyKeyboard: true,
	});
	try {
		const selected = pickSession(view.renderer, [sessions[0]!]);
		await view.flush();
		expect(view.captureCharFrame()).toContain("/tmp/project-1");
		view.mockInput.pressEnter();
		await expect(selected).resolves.toBe("session-1");
	} finally {
		view.renderer.destroy();
	}
});

test("selects beyond the five visible resume rows", async () => {
	const view = await createTestRenderer({
		width: 100,
		height: 20,
		kittyKeyboard: true,
	});
	try {
		const selected = pickSession(view.renderer, sessions);
		await view.flush();
		expect(view.captureCharFrame()).toContain("Resume session");
		for (let index = 0; index < 5; index++) view.mockInput.pressArrow("down");
		view.mockInput.pressEnter();
		await expect(selected).resolves.toBe("session-6");
	} finally {
		view.renderer.destroy();
	}
});

test("cancels the inline resume picker with Escape", async () => {
	const view = await createTestRenderer({
		width: 100,
		height: 20,
		kittyKeyboard: true,
	});
	try {
		const selected = pickSession(view.renderer, sessions);
		await view.flush();
		view.mockInput.pressEscape();
		await expect(selected).resolves.toBeUndefined();
	} finally {
		view.renderer.destroy();
	}
});
