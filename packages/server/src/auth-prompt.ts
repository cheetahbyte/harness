import type { AuthPrompt } from "@earendil-works/pi-ai";

/** Pi select prompts require option ids even when a terminal displays labels. */
export function authPromptAnswer(prompt: AuthPrompt, answer: string): string {
	if (prompt.type !== "select") return answer;
	const value = answer.trim();
	if (!value) return prompt.options[0]?.id ?? "";
	return (
		prompt.options.find(
			(option) => option.id === value || option.label === value,
		)?.id ?? value
	);
}
