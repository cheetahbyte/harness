import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "harnez-test-config-"));
process.env["XDG_CONFIG_HOME"] = configDir;

afterAll(() => rmSync(configDir, { recursive: true, force: true }));
