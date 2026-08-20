import {
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export type MemoryScope = "project" | "local" | "user";

function memoryDirectory(
	workspace: string,
	profile: string,
	scope: MemoryScope,
	home = homedir(),
): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(profile))
		throw new Error("invalid profile name");
	return scope === "project"
		? join(workspace, ".harnez", "agent-memory", profile)
		: scope === "local"
			? join(workspace, ".harnez", "agent-memory-local", profile)
			: join(home, ".config", "harnez", "agent-memory", profile);
}

export async function memoryIndex(
	workspace: string,
	profile: string,
	scope: MemoryScope,
	home?: string,
): Promise<string> {
	try {
		return await readFile(
			join(memoryDirectory(workspace, profile, scope, home), "MEMORY.md"),
			"utf8",
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function safeName(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[^/\\]+\.md$/.test(value) ||
		value === "..md"
	)
		throw new Error("memory file must be a sibling Markdown file");
	return value;
}

function confined(root: string, name: unknown): string {
	const path = resolve(root, safeName(name));
	if (relative(root, path).startsWith(".."))
		throw new Error("memory path escapes profile memory");
	return path;
}

/** Agent-facing tools for one profile's explicitly selected memory scope. */
export function profileMemoryTools(
	workspace: string,
	profile: string,
	scope: MemoryScope,
	canWrite: boolean,
	home?: string,
): AgentTool[] {
	const root = memoryDirectory(workspace, profile, scope, home);
	const list: AgentTool = {
		name: "memory_list",
		label: "memory_list",
		description: "List Markdown files in this profile's durable memory.",
		parameters: Type.Object({}),
		execute: async () => {
			let names: string[] = [];
			try {
				names = (await readdir(root, { withFileTypes: true }))
					.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
					.map((entry) => entry.name)
					.toSorted();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return {
				content: [{ type: "text", text: names.join("\n") || "(empty)" }],
				details: {},
			};
		},
	};
	const read: AgentTool = {
		name: "memory_read",
		label: "memory_read",
		description: "Read one Markdown file from this profile's durable memory.",
		parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
		execute: async (_id, rawInput) => {
			const input = rawInput as { name: unknown };
			return {
				content: [
					{
						type: "text",
						text: await readFile(confined(root, input.name), "utf8"),
					},
				],
				details: {},
			};
		},
	};
	const tools = [list, read];
	if (canWrite)
		tools.push({
			name: "memory_write",
			label: "memory_write",
			description:
				"Atomically write one Markdown file in this profile's durable memory.",
			parameters: Type.Object({
				name: Type.String({ minLength: 1 }),
				content: Type.String(),
			}),
			execute: async (_id, rawInput) => {
				const input = rawInput as { name: unknown; content: unknown };
				const path = confined(root, input.name);
				if (typeof input.content !== "string")
					throw new Error("content must be a string");
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.${crypto.randomUUID()}.tmp`;
				try {
					await writeFile(temporary, input.content, "utf8");
					await rename(temporary, path);
				} finally {
					try {
						await unlink(temporary);
					} catch {
						/* best effort */
					}
				}
				return {
					content: [{ type: "text", text: `wrote ${input.name}` }],
					details: {},
				};
			},
		});
	return tools;
}
