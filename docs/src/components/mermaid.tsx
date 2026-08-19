import { createEffect, createSignal } from "solid-js";

async function render(chart: string): Promise<string> {
	const { default: mermaid } = await import("mermaid");
	mermaid.initialize({ startOnLoad: false, theme: "default" });
	return (await mermaid.render(`mermaid-${crypto.randomUUID()}`, chart)).svg;
}

export async function renderMermaidBlocks(root: ParentNode): Promise<void> {
	for (const block of root.querySelectorAll<HTMLElement>(
		'pre[data-lang="mermaid"]',
	)) {
		const container = document.createElement("div");
		container.className = "mermaid-diagram";
		container.innerHTML = await render(block.textContent ?? "");
		block.replaceWith(container);
	}
}

export function Mermaid(props: { chart: string }) {
	const [svg, setSvg] = createSignal("");

	createEffect(() => void render(props.chart).then(setSvg));

	return <div class="mermaid-diagram" innerHTML={svg()} />;
}
