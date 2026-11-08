/**
 * Wire contract for UsingOpen agent sessions (the 60-minute hard stop).
 *
 * The backend owns the session clock: `POST /v1/sessions` mints a session row
 * whose `started_at` is authoritative across instances and redeploys, every
 * other `/v1` call presents the id in the {@link AGENT_SESSION_HEADER} header,
 * and past {@link AGENT_SESSION_TTL_MS} the answer is `403 session_expired`
 * with the in-flight request aborted — the id never resumes.
 *
 * This module carries the client half of that contract: the header name, the
 * product limits, the minted-session shape, and the phase/remaining helpers
 * the TUI's warning, countdown, and read-only end state are computed from.
 * They mirror the server constants so a host never re-derives them, and they
 * are deliberately pure so a fake clock in a test pins every boundary.
 */

/** Header every `/v1` call (except the mint) must carry with the session id. */
export const AGENT_SESSION_HEADER = "x-agent-session";

/** Path appended to the API base that mints a session. */
export const AGENT_SESSION_MINT_PATH = "/v1/sessions";

/** Hard stop: a session dies exactly this long after its `started_at`. */
export const AGENT_SESSION_TTL_MS = 60 * 60 * 1000;

/** Warning window: the remaining time at which the countdown surface starts. */
export const AGENT_SESSION_WARNING_MS = 55 * 60 * 1000;

/** The TTL in whole seconds, as the mint reply reports it. */
export const AGENT_SESSION_MAX_AGE_SECONDS = Math.round(AGENT_SESSION_TTL_MS / 1000);

/** A session as minted by `POST /v1/sessions` (timestamps are ISO 8601). */
export interface AgentSessionRecord {
	readonly id: string;
	readonly sub: string;
	readonly startedAt: string;
	readonly expiresAt: string;
	readonly maxAgeSeconds: number;
}

/**
 * Lifecycle phase of a session from the client's seat:
 * - `none`: no session adopted (feature off, mint failed, or none restored);
 * - `active`: inside the first {@link AGENT_SESSION_WARNING_MS} of life;
 * - `warning`: the last {@link AGENT_SESSION_TTL_MS} minus
 *   {@link AGENT_SESSION_WARNING_MS} — countdown surface on, sends still allowed;
 * - `expired`: hard stop reached locally or a `403 session_expired` observed —
 *   read-only end state, only minting a new session moves forward.
 */
export type AgentSessionPhase = "none" | "active" | "warning" | "expired";

/** `started_at` as epoch ms; `null` when the value is missing or unparseable. */
export function agentSessionStartedMs(session: AgentSessionRecord | null): number | null {
	if (!session) return null;
	const parsed = Date.parse(session.startedAt);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Milliseconds left before the hard stop, clamped at zero. Calculations key
 * off `expiresAt` when parseable so a server whose clock differs from the
 * host's still expires at the server's moment; `null` without a usable
 * session.
 */
export function agentSessionRemainingMs(session: AgentSessionRecord | null, now: number): number | null {
	if (!session) return null;
	const expires = Date.parse(session.expiresAt);
	if (!Number.isFinite(expires)) return null;
	return Math.max(0, expires - now);
}

/**
 * Phase of `session` at `now`. The boundaries are the product limits, so the
 * 55:00 warning and the 60:00 hard stop derive from the same constants the
 * server enforces. An unusable record reads as `expired`: a session the host
 * cannot date is one it must not keep sending on.
 */
export function agentSessionPhase(session: AgentSessionRecord | null, now: number): AgentSessionPhase {
	if (!session) return "none";
	const remaining = agentSessionRemainingMs(session, now);
	if (remaining === null) return "expired";
	const ageMs = AGENT_SESSION_TTL_MS - remaining;
	if (ageMs >= AGENT_SESSION_TTL_MS) return "expired";
	if (ageMs >= AGENT_SESSION_WARNING_MS) return "warning";
	return "active";
}

/**
 * Parse a mint reply (or a persisted copy of one) into a record; `null` when
 * the shape is unusable. Unknown extra fields are dropped, never trusted.
 */
export function parseAgentSession(raw: unknown): AgentSessionRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id.trim() : "";
	const sub = typeof rec.sub === "string" ? rec.sub.trim() : "";
	const startedAt = typeof rec.started_at === "string" ? rec.started_at : "";
	const expiresAt = typeof rec.expires_at === "string" ? rec.expires_at : "";
	if (!id || !startedAt || !expiresAt) return null;
	if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(expiresAt))) return null;
	const maxAgeSeconds =
		typeof rec.max_age_seconds === "number" && Number.isFinite(rec.max_age_seconds) && rec.max_age_seconds > 0
			? Math.floor(rec.max_age_seconds)
			: AGENT_SESSION_MAX_AGE_SECONDS;
	return { id, sub, startedAt, expiresAt, maxAgeSeconds };
}
