/** Resolves early when the optional signal is aborted. */
export function abortableSleep(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const finish = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timeout = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}
