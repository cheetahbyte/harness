import { expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
} from "@earendil-works/pi-ai";

import { streamWithRetry } from "../src/agent/runtime";

test("turns a provider stream without a terminal event into an error", async () => {
	const events: AssistantMessageEvent[] = [];
	const stream = streamWithRetry(
		() => {
			const source = createAssistantMessageEventStream();
			queueMicrotask(() => source.end());
			return source;
		},
		undefined,
		{ sessionId: "session-1", provider: "test", model: "test-model" },
		() => {},
	);

	for await (const event of stream) events.push(event);

	expect(events.at(-1)).toMatchObject({
		type: "error",
		reason: "error",
		error: {
			stopReason: "error",
			errorMessage: "provider stream ended without a terminal event",
		},
	});
});
