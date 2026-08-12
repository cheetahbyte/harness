import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../shared/src/version";
import { dataDirectory, health } from "./server-command";
import { compareVersions, latestVersion } from "./update";

const CACHE_FILE = "update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Cache = { checkedAt: number; latest: string };

function cachePath(): string {
	return join(dataDirectory(), CACHE_FILE);
}

function readCache(now: number): Cache | undefined {
	try {
		const cache = JSON.parse(
			readFileSync(cachePath(), "utf8"),
		) as Partial<Cache>;
		if (
			typeof cache.latest !== "string" ||
			typeof cache.checkedAt !== "number" ||
			/** A clock that moved backwards would pin a stale answer forever. */
			cache.checkedAt > now ||
			now - cache.checkedAt >= CHECK_INTERVAL_MS
		)
			return undefined;
		return { checkedAt: cache.checkedAt, latest: cache.latest };
	} catch {
		return undefined;
	}
}

function writeCache(cache: Cache): void {
	try {
		mkdirSync(dataDirectory(), { recursive: true });
		writeFileSync(cachePath(), `${JSON.stringify(cache)}\n`);
	} catch {}
}

/**
 * Resolves the newest published version, reusing a cached answer for a day so
 * routine use does not hit the registry — or repeat the same notice — on every
 * launch. Returns undefined when the check is disabled or fails, because an
 * unreachable registry is not a reason to interrupt a session.
 */
export async function checkLatestVersion(): Promise<string | undefined> {
	if (process.env["HARNEZ_DISABLE_UPDATE_CHECK"] === "1") return undefined;
	const now = Date.now();
	const cached = readCache(now);
	if (cached) return cached.latest;
	try {
		const latest = await latestVersion();
		writeCache({ checkedAt: now, latest });
		return latest;
	} catch {
		return undefined;
	}
}

/**
 * Two widths of the same message. The header shares one row with the session
 * label, so a notice that always spelled itself out would collide with it on a
 * narrow terminal; the short form keeps the signal visible where the long one
 * does not fit.
 */
export type UpdateNotice = { full: string; short: string };

/**
 * Describes whatever is out of date, or undefined when everything matches. A
 * running server keeps serving the build it started with, so a server left
 * behind by an earlier update is reported even when the installed release is
 * already current.
 */
export async function updateNotice(): Promise<UpdateNotice | undefined> {
	const [latest, running] = await Promise.all([
		checkLatestVersion(),
		health().catch(() => undefined),
	]);
	if (latest && compareVersions(latest, VERSION) > 0)
		return {
			full: `update available: ${VERSION} → ${latest} · run \`harnez update\``,
			short: `update ${latest}`,
		};
	if (running?.version && compareVersions(running.version, VERSION) !== 0)
		return {
			full: `server on ${running.version}, client on ${VERSION} · run \`harnez server restart\``,
			short: `server ${running.version}`,
		};
	return undefined;
}
