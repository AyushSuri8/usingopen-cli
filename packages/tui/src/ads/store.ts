import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ADS_URL } from "@usingopen/wire";
import { getConfigDirName } from "@usingopen/utils/dirs";

/**
 * On-disk state for the ad client: a feed cache and a persistent state file
 * (dismissals + per-ad show counts). Both live in the post-rename config root
 * (`~/.usingopen/ads/`) — deliberately not the legacy `~/.omp` fallback root,
 * like the install id.
 */

/** Ads subdirectory name inside the config root. */
const ADS_DIR_NAME = "ads";

/** `USINGOPEN_ADS=0` (or `false`/`off`) disables every ad surface. */
export function adsEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.USINGOPEN_ADS?.trim().toLowerCase();
	if (raw === undefined || raw === "") return true;
	return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** Ad server base URL; `USINGOPEN_ADS_URL` overrides the default per-install. */
export function adsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.USINGOPEN_ADS_URL?.trim();
	if (!raw) return DEFAULT_ADS_URL;
	try {
		const url = new URL(raw);
		return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
	} catch {
		return DEFAULT_ADS_URL;
	}
}

/** Config-root-relative ads directory (honors `USINGOPEN_CONFIG_DIR`/`PI_CONFIG_DIR`). */
export function adsDir(): string {
	return path.join(os.homedir(), getConfigDirName(), ADS_DIR_NAME);
}

/** Path of the cached feed document. */
export function adsFeedCachePath(): string {
	return path.join(adsDir(), "feed.json");
}

/** Path of the dismissal/counter state document. */
export function adsStatePath(): string {
	return path.join(adsDir(), "state.json");
}

/** Atomic write: tmp file in the same directory, then rename over the target. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, filePath);
	} catch {
		// Ads state is best-effort: a read-only home or a full disk must never
		// surface as a UI error.
	}
}

/** Read and JSON-parse a cache/state file; `null` on any failure. */
export function readJsonFile<T>(filePath: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}
