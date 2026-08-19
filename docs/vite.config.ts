import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";

import solidPlugin from "vite-plugin-solid";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		cloudflare({
			config: { main: "@tanstack/solid-start/server-entry" },
			viteEnvironment: { name: "ssr" },
		}),
		devtools(),
		tailwindcss(),
		tanstackStart(),
		solidPlugin({ ssr: true }),
	],
});
