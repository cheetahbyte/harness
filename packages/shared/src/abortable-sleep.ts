/** Resolves early when the optional signal is aborted. */
export function abortableSleep(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const abort = () => {
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
