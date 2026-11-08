/**
 * Live verification burst for the WorkOS backend wiring against staging.
 *
 * The API key is read from the staging key file only — never from the
 * environment — and this report carries statuses, ids, and token shapes, not
 * secret values. Run it in small batches; each check below is independent.
 *
 * Environment inputs (all optional unless noted):
 *   USINGOPEN_CLIENT_ID        AuthKit client id — required
 *   WORKOS_VERIFY_EMAIL        staging user email; with the password below it
 *                              mints a token pair (token verify, refresh rotation)
 *   WORKOS_VERIFY_PASSWORD     that user's password
 *   WORKOS_VERIFY_USER_ID      user-read target (defaults to the minted user,
 *                              else the first user the environment lists)
 *   WORKOS_VERIFY_ORG_ID       org-read target (defaults to the first
 *                              organization the environment lists)
 *   WORKOS_ADS_URL             ad network base URL (defaults to DEFAULT_ADS_URL)
 *   WORKOS_ADS_AD_ID           ad id for the impression beacon (default: a house ad)
 *   WORKOS_ADS_INSTALL_ID      install id for the beacon (defaults to this machine's)
 *
 * Exit code is 1 when any check fails; SKIP (missing input) does not fail.
 *
 *   USINGOPEN_CLIENT_ID=client_… WORKOS_VERIFY_EMAIL=… WORKOS_VERIFY_PASSWORD=… \
 *     bun --cwd packages/ai scripts/workos-staging-burst.ts
 */
import { $env } from "@usingopen/utils";
import { getInstallId } from "@usingopen/utils/dirs";
import { DEFAULT_ADS_URL } from "@usingopen/wire";
import { loadWorkosApiKey, type WorkOSTokenGrant, WorkOSBackend } from "../src/auth/workos-backend";

type CheckStatus = "ok" | "fail" | "skip";
const results: Array<{ name: string; status: CheckStatus; detail: string }> = [];

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function report(name: string, status: CheckStatus, detail: string): void {
	results.push({ name, status, detail });
	console.log(`[${status.toUpperCase()}] ${name} — ${detail}`);
}

function env(name: string): string | undefined {
	const value = $env[name]?.trim();
	return value ? value : undefined;
}

const clientId = env("USINGOPEN_CLIENT_ID");
if (!clientId) {
	console.error("USINGOPEN_CLIENT_ID is required (WorkOS AuthKit public client id)");
	process.exit(1);
}

const backend = new WorkOSBackend({ apiKey: await loadWorkosApiKey() });

// Batch 1 — mint a token pair headlessly when staging credentials are provided.
let grant: WorkOSTokenGrant | undefined;
const email = env("WORKOS_VERIFY_EMAIL");
const password = $env.WORKOS_VERIFY_PASSWORD;
if (email && password) {
	try {
		grant = await backend.authenticateWithPassword(clientId, email, password);
		report(
			"token mint (password grant)",
			"ok",
			`user=${grant.user.id} email=${grant.user.email ?? "-"} emailVerified=${grant.user.emailVerified}`,
		);
	} catch (error) {
		report("token mint (password grant)", "fail", describeError(error));
	}
} else {
	report("token mint (password grant)", "skip", "set WORKOS_VERIFY_EMAIL and WORKOS_VERIFY_PASSWORD to mint tokens");
}

// Check 1 — token verify: JWKS/RS256 signature, issuer, and expiry against staging.
if (grant) {
	try {
		const claims = await backend.verifyAccessToken(grant.accessToken, clientId);
		report(
			"token verify (JWKS/RS256)",
			"ok",
			`sub=${claims.userId} sid=${claims.sessionId ?? "-"} expiresIn=${Math.round((claims.expiresAtMs - Date.now()) / 1000)}s`,
		);
	} catch (error) {
		report("token verify (JWKS/RS256)", "fail", describeError(error));
	}
	try {
		await backend.verifyAccessToken(`${grant.accessToken.slice(0, -4)}AAAA`, clientId);
		report("token verify rejects a tampered token", "fail", "the tampered token verified");
	} catch (error) {
		report("token verify rejects a tampered token", "ok", describeError(error));
	}
} else {
	report("token verify (JWKS/RS256)", "skip", "no minted token");
}

// Check 2 — user read with the API key.
const userId = env("WORKOS_VERIFY_USER_ID") ?? grant?.user.id;
if (userId) {
	try {
		const user = await backend.readUser(userId);
		report("user read", "ok", `${user.id} email=${user.email ?? "-"} emailVerified=${user.emailVerified}`);
	} catch (error) {
		report("user read", "fail", describeError(error));
	}
} else {
	try {
		const users = await backend.listUsers(1);
		if (users.length === 0) {
			report("user read", "skip", "environment lists no users; set WORKOS_VERIFY_USER_ID");
		} else {
			const user = await backend.readUser(users[0]!.id);
			report("user read", "ok", `${user.id} email=${user.email ?? "-"} emailVerified=${user.emailVerified}`);
		}
	} catch (error) {
		report("user read", "fail", describeError(error));
	}
}

// Check 3 — organization read with the API key.
const organizationId = env("WORKOS_VERIFY_ORG_ID");
if (organizationId) {
	try {
		const organization = await backend.readOrganization(organizationId);
		report("org read", "ok", `${organization.id} name=${organization.name}`);
	} catch (error) {
		report("org read", "fail", describeError(error));
	}
} else {
	try {
		const organizations = await backend.listOrganizations(1);
		if (organizations.length === 0) {
			report("org read", "skip", "environment lists no organizations; set WORKOS_VERIFY_ORG_ID");
		} else {
			const organization = await backend.readOrganization(organizations[0]!.id);
			report("org read", "ok", `${organization.id} name=${organization.name}`);
		}
	} catch (error) {
		report("org read", "fail", describeError(error));
	}
}

// Check 4 — refresh rotation: exchange the refresh token, then prove the new
// access token verifies and record whether WorkOS rotated the refresh token.
if (grant?.refreshToken) {
	try {
		const rotated = await backend.refreshTokenGrant(clientId, grant.refreshToken);
		const claims = await backend.verifyAccessToken(rotated.accessToken, clientId);
		report(
			"refresh rotation",
			"ok",
			`newAccess=${rotated.accessToken !== grant.accessToken} rotatedRefresh=${rotated.refreshToken !== grant.refreshToken} verifiesAs=${claims.userId}`,
		);
	} catch (error) {
		report("refresh rotation", "fail", describeError(error));
	}
} else {
	report("refresh rotation", "skip", "no minted refresh token");
}

// Check 5 — ads beacon auth: install-id attribution plus the API-key bearer
// against the (staging) ad network.
const installId = env("WORKOS_ADS_INSTALL_ID") ?? getInstallId();
try {
	const beacon = await backend.authenticateAdsBeacon({
		installId,
		adId: env("WORKOS_ADS_AD_ID") ?? "house.collab",
		adsBaseUrl: env("WORKOS_ADS_URL") ?? DEFAULT_ADS_URL,
	});
	const body = JSON.stringify(beacon.body).slice(0, 160);
	report("ads beacon auth", beacon.ok ? "ok" : "fail", `HTTP ${beacon.status} ${body}`);
} catch (error) {
	report("ads beacon auth", "fail", describeError(error));
}

const failed = results.filter(result => result.status === "fail").length;
const skipped = results.filter(result => result.status === "skip").length;
console.log(
	`\n${results.length - failed - skipped}/${results.length} checks passed, ${failed} failed, ${skipped} skipped`,
);
if (failed > 0) process.exitCode = 1;
