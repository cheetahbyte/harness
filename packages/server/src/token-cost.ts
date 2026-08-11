export function tokenCost(value: unknown, minimum = 0): number {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(minimum, Math.ceil(text.length / 4));
}
