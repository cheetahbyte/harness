import { expect, test } from "bun:test";
import { abortableSleep } from "./abortable-sleep";

test("abortableSleep resolves when aborted", async () => {
	const controller = new AbortController();
	const pending = abortableSleep(1_000, controller.signal);
	controller.abort();
	await expect(pending).resolves.toBeUndefined();
});
