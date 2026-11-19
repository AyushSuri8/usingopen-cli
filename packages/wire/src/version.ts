/**
 * Shared client-identity and version header names exchanged between usingopen
 * clients and the auth-gateway.
 *
 * Canonical `x-usingopen-*` headers are preferred; legacy `x-omp-*` names are
 * dual-sent during rollout and accepted as fallbacks by the gateway. None of
 * these headers are forwarded to upstream inference providers.
 */

export const CLIENT_HEADER_NAMES = {
	installId: "x-usingopen-install-id",
	hostname: "x-usingopen-hostname",
	app: "x-usingopen-app",
	version: "x-usingopen-version",
	legacyInstallId: "x-omp-install-id",
	legacyHostname: "x-omp-hostname",
	legacyApp: "x-omp-app",
	legacyVersion: "x-omp-version",
} as const;

/** Canonical client-version request header (`x-usingopen-version`). */
export const CLIENT_VERSION_HEADER = CLIENT_HEADER_NAMES.version;

/** Legacy client-version request header (`x-omp-version`), dual-sent during rollout. */
export const LEGACY_CLIENT_VERSION_HEADER = CLIENT_HEADER_NAMES.legacyVersion;

/** Response header emitted when the gateway allows a request with a version policy warning. */
export const CLIENT_VERSION_WARNING_HEADER = "x-usingopen-version-warning";

/** Response header advertising the gateway's configured minimum client version. */
export const MIN_CLIENT_VERSION_HEADER = "x-usingopen-min-version";
