import { homedir } from "node:os";
import { join } from "node:path";

export function userConfigPath(file: string, home?: string): string {
	return join(
		home
			? join(home, ".config")
			: (process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")),
		"harnez",
		file,
	);
}

export function userDataDirectory(home?: string): string {
	if (process.env["HARNEZ_DATA_DIR"]) return process.env["HARNEZ_DATA_DIR"];
	if (process.platform === "win32")
		return join(
			process.env["LOCALAPPDATA"] ??
				join(home ?? homedir(), "AppData", "Local"),
			"harnez",
		);
	return join(
		home
			? join(home, ".local", "share")
			: (process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")),
		"harnez",
	);
}

export function userDataPath(file: string, home?: string): string {
	return join(userDataDirectory(home), file);
}
