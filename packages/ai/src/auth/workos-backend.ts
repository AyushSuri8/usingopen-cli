/**
 * WorkOS backend wiring for UsingOpen services.
 *
 * The CLI authenticates end users through AuthKit's public-client flows (the
 * PKCE browser login and the RFC 8628 device fallback in
 * `compat/rules/auth/usingopen*.kdl`), which never carry a client secret.
 * Backend services act on the environment instead: they hold the WorkOS API
 * key and use it to verify the access tokens those flows mint, read the user
 * and organization records behind them, exchange refresh tokens, and
 * authenticate ad-network beacons. This staging app is first-party, so its
 * token grants take the API key as the client secret; the CLI-side public
 * flows remain secret-free.
 *
 * The API key is read from exactly one place — the file at
 * {@link WORKOS_API_KEY_PATH} — and is never printed, logged, or committed.
 * The file lives outside the checkout with mode 0600.
 */
import { ADS_HEADER_NAMES, ADS_IMPRESSION_PATH, DEFAULT_ADS_URL } from "@usingopen/wire";
import * as AIError from "../error";
import type { FetchImpl } from "../types";

/** Staging WorkOS API key file. Outside the repo, mode 0600; the only key source. */
export const WORKOS_API_KEY_PATH = "/teamspace/studios/this_studio/.secrets/workos_staging.key";

const API_BASE_URL = "https://api.workos.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** JWKS entries are cached this long; WorkOS rotates signing keys rarely. */
const JWKS_CACHE_TTL_MS = 5 * 60_000;
/** Tolerance applied to `exp`/`iat` when verifying tokens (clock drift). */
const CLOCK_SKEW_MS = 30_000;

/** An AuthKit user as projected for backend callers. */
export interface WorkOSUser {
	readonly id: string;
	readonly email: string | undefined;
	readonly emailVerified: boolean;
}

/** An organization as projected for backend callers. */
export interface WorkOSOrganization {
	readonly id: string;
	readonly name: string;
}

/** Claims a verified WorkOS access token must carry. */
export interface WorkOSTokenClaims {
	readonly userId: string;
	readonly sessionId: string | undefined;
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
}

/** A minted or rotated token pair plus the user it authenticates. */
export interface WorkOSTokenGrant {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly user: WorkOSUser;
}

/** Outcome of one ad-network impression beacon. */
export interface AdsBeaconResult {
	readonly status: number;
	readonly ok: boolean;
	readonly body: unknown;
}

/** Reads the WorkOS API key from {@link WORKOSApiKeyPath}; the value never enters a log line. */
export async function loadWorkosApiKey(keyPath: string = WORKOS_API_KEY_PATH): Promise<string> {
	let text: string;
	try {
		text = await Bun.file(keyPath).text();
	} catch (cause) {
		throw new AIError.ConfigurationError(`WorkOS API key file ${keyPath} could not be read`, { cause });
	}
	const key = text.trim();
	if (!key) {
		throw new AIError.ConfigurationError(`WorkOS API key file ${keyPath} is empty`);
	}
	return key;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(value, "base64url"));
}

function decodeBase64UrlText(value: string): string {
	return Buffer.from(value, "base64url").toString("utf8");
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

interface Jwk {
	readonly kty: string;
	readonly kid?: string;
	readonly alg?: string;
	readonly use?: string;
	readonly n?: string;
	readonly e?: string;
}

function userFrom(body: unknown): WorkOSUser {
	const record = (body ?? {}) as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	if (!id) {
		throw new AIError.OAuthError("WorkOS response is missing the user id", {
			kind: "validation",
			provider: "usingopen",
		});
	}
	return {
		id,
		email: typeof record.email === "string" ? record.email : undefined,
		emailVerified: record.email_verified === true,
	};
}

/**
 * Server-side WorkOS client. Every method authenticates with the API key
 * (token grants send it as the client secret of this first-party app) and
 * times out at {@link REQUEST_TIMEOUT_MS}. `fetch` is injectable for tests.
 */
export class WorkOSBackend {
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #fetch: FetchImpl;
	readonly #jwks = new Map<string, { fetchedAt: number; keys: readonly Jwk[] }>();

	constructor(options: { apiKey: string; baseUrl?: string; fetch?: FetchImpl }) {
		this.#apiKey = options.apiKey;
		this.#baseUrl = options.baseUrl ?? API_BASE_URL;
		this.#fetch = options.fetch ?? fetch;
	}

	/**
	 * Verifies an access token the way WorkOS documents for first-party APIs:
	 * RS256 signature against the client's JWKS, then `exp`/`iat` skew and the
	 * per-client issuer. Throws {@link AIError.OAuthError} on any failure; the
	 * returned claims identify the user and session the token authenticates.
	 */
	async verifyAccessToken(token: string, clientId: string): Promise<WorkOSTokenClaims> {
		const parts = token.split(".");
		if (parts.length !== 3) {
			throw new AIError.OAuthError("WorkOS access token is not a JWT", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
		let header: { alg?: string; kid?: string };
		let claims: Record<string, unknown>;
		try {
			header = parseJson<{ alg?: string; kid?: string }>(decodeBase64UrlText(headerPart));
			claims = parseJson<Record<string, unknown>>(decodeBase64UrlText(payloadPart));
		} catch (cause) {
			throw new AIError.OAuthError("WorkOS access token is not decodable", {
				kind: "validation",
				provider: "usingopen",
				cause,
			});
		}
		if (header.alg !== "RS256" || !header.kid) {
			throw new AIError.OAuthError(`WorkOS access token alg ${header.alg ?? "?"} is not RS256`, {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const jwk = await this.#signingKey(clientId, header.kid);
		if (!jwk.n || !jwk.e) {
			throw new AIError.OAuthError("WorkOS JWKS entry is missing RSA parameters", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const verified = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			decodeBase64Url(signaturePart),
			new TextEncoder().encode(`${headerPart}.${payloadPart}`),
		);
		if (!verified) {
			throw new AIError.OAuthError("WorkOS access token signature verification failed", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const now = Date.now();
		const issuedAtMs = typeof claims.iat === "number" ? claims.iat * 1000 : undefined;
		const expiresAtMs = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
		if (expiresAtMs === undefined || issuedAtMs === undefined) {
			throw new AIError.OAuthError("WorkOS access token is missing exp/iat claims", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		if (expiresAtMs + CLOCK_SKEW_MS < now) {
			throw new AIError.OAuthError("WorkOS access token is expired", { kind: "validation", provider: "usingopen" });
		}
		if (issuedAtMs - CLOCK_SKEW_MS > now) {
			throw new AIError.OAuthError("WorkOS access token was issued in the future", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const expectedIssuer = `${this.#baseUrl}/user_management/${clientId}`;
		if (claims.iss !== expectedIssuer) {
			throw new AIError.OAuthError(`WorkOS access token issuer ${String(claims.iss)} is not ${expectedIssuer}`, {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const userId = typeof claims.sub === "string" ? claims.sub : "";
		if (!userId) {
			throw new AIError.OAuthError("WorkOS access token is missing the sub claim", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		return {
			userId,
			sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
			expiresAtMs,
			issuedAtMs,
		};
	}

	/** Reads one user by id. */
	async readUser(userId: string): Promise<WorkOSUser> {
		const body = await this.#get(`/user_management/users/${encodeURIComponent(userId)}`);
		return userFrom(body);
	}

	/** Lists users (newest first per WorkOS' default order). */
	async listUsers(limit = 10): Promise<readonly WorkOSUser[]> {
		const body = await this.#get(`/user_management/users?limit=${limit}`);
		const rows = ((body as { data?: unknown }).data ?? []) as Array<Record<string, unknown>>;
		return rows.filter(row => typeof row.id === "string" && row.id.length > 0).map(userFrom);
	}

	/** Lists organizations. */
	async listOrganizations(limit = 10): Promise<readonly WorkOSOrganization[]> {
		const body = await this.#get(`/organizations?limit=${limit}`);
		const rows = ((body as { data?: unknown }).data ?? []) as Array<Record<string, unknown>>;
		return rows
			.filter(row => typeof row.id === "string" && typeof row.name === "string")
			.map(row => ({ id: row.id as string, name: row.name as string }));
	}

	/**
	 * Reads one organization by id. The AuthKit `user_management/organizations`
	 * routes are not served in the staging environment; the platform
	 * organizations API answers here.
	 */
	async readOrganization(organizationId: string): Promise<WorkOSOrganization> {
		const body = await this.#get(`/organizations/${encodeURIComponent(organizationId)}`);
		const record = (body ?? {}) as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : "";
		const name = typeof record.name === "string" ? record.name : "";
		if (!id || !name) {
			throw new AIError.OAuthError("WorkOS organization response is missing id/name", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		return { id, name };
	}

	/** Headless email+password sign-in (admin/CI token minting on staging). */
	async authenticateWithPassword(clientId: string, email: string, password: string): Promise<WorkOSTokenGrant> {
		return this.#grant({ grant_type: "password", client_id: clientId, email, password });
	}

	/** Exchanges a refresh token for a fresh pair; the reply's refresh token wins when rotated. */
	async refreshTokenGrant(clientId: string, refreshToken: string): Promise<WorkOSTokenGrant> {
		return this.#grant({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
	}

	/**
	 * Authenticates an impression beacon against the ad network: the install id
	 * under both attribution header names (per `packages/wire/src/ads.ts`) and
	 * the WorkOS API key as the bearer, so the ad server can attribute the
	 * beacon and reject forged ones.
	 */
	async authenticateAdsBeacon(options: {
		installId: string;
		adId: string;
		adsBaseUrl?: string;
	}): Promise<AdsBeaconResult> {
		const base = options.adsBaseUrl ?? DEFAULT_ADS_URL;
		const response = await this.#request(`${base}${ADS_IMPRESSION_PATH}`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"Content-Type": "application/json",
				[ADS_HEADER_NAMES.installId]: options.installId,
				[ADS_HEADER_NAMES.legacyInstallId]: options.installId,
			},
			body: JSON.stringify({ adId: options.adId }),
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = parseJson<unknown>(text);
		} catch {
			// Non-JSON error pages stay as text.
		}
		return { status: response.status, ok: response.ok, body };
	}

	async #grant(params: Record<string, string>): Promise<WorkOSTokenGrant> {
		const response = await this.#request(`${this.#baseUrl}/user_management/authenticate`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_secret: this.#apiKey, ...params }).toString(),
		});
		const body = await this.#json(response);
		const record = (body ?? {}) as Record<string, unknown>;
		const accessToken = typeof record.access_token === "string" ? record.access_token : "";
		const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : "";
		if (!accessToken) {
			throw new AIError.OAuthError("WorkOS token grant response is missing access_token", {
				kind: "validation",
				provider: "usingopen",
			});
		}
		return { accessToken, refreshToken, user: userFrom(record.user) };
	}

	async #get(path: string): Promise<unknown> {
		return this.#json(await this.#request(`${this.#baseUrl}${path}`, { method: "GET" }));
	}

	async #request(url: string, init: RequestInit): Promise<Response> {
		try {
			return await this.#fetch(url, {
				...init,
				headers: { Authorization: `Bearer ${this.#apiKey}`, ...(init.headers as Record<string, string>) },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (cause) {
			throw new AIError.OAuthError(
				`WorkOS request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				{
					kind: "http",
					provider: "usingopen",
					cause,
				},
			);
		}
	}

	async #json(response: Response): Promise<unknown> {
		const text = await response.text();
		if (!response.ok) {
			throw new AIError.OAuthError(`WorkOS request failed: ${response.status} ${text.slice(0, 500)}`, {
				kind: "http",
				provider: "usingopen",
				status: response.status,
			});
		}
		try {
			return parseJson<unknown>(text);
		} catch (cause) {
			throw new AIError.OAuthError(`WorkOS returned an unparseable body: ${response.status}`, {
				kind: "validation",
				provider: "usingopen",
				status: response.status,
				cause,
			});
		}
	}

	async #signingKey(clientId: string, kid: string): Promise<Jwk> {
		const cached = this.#jwks.get(clientId);
		if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
			const hit = cached.keys.find(key => key.kid === kid);
			if (hit) return hit;
			throw new AIError.OAuthError(`WorkOS JWKS has no key for kid ${kid}`, {
				kind: "validation",
				provider: "usingopen",
			});
		}
		const body = await this.#json(
			await this.#request(`${this.#baseUrl}/sso/jwks/${encodeURIComponent(clientId)}`, { method: "GET" }),
		);
		const keys = Array.isArray((body as { keys?: unknown }).keys) ? ((body as { keys: Jwk[] }).keys as Jwk[]) : [];
		if (keys.length === 0) {
			throw new AIError.OAuthError("WorkOS JWKS is empty", { kind: "validation", provider: "usingopen" });
		}
		this.#jwks.set(clientId, { fetchedAt: Date.now(), keys });
		const match = keys.find(key => key.kid === kid);
		if (!match) {
			throw new AIError.OAuthError(`WorkOS JWKS has no key for kid ${kid}`, {
				kind: "validation",
				provider: "usingopen",
			});
		}
		return match;
	}
}
