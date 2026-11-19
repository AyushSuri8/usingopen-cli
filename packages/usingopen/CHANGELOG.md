# Changelog

## [Unreleased]

### Added

- `npm install -g usingopen`, which installs the released binary without requiring Bun.

### Changed

- The package's `repository` metadata and the documented install routes now point at the public [`AyushSuri8/usingopen-cli`](https://github.com/AyushSuri8/usingopen-cli) repository.
- The launcher downloads binaries built from this repository, so `usingopen --version` reports `usingopen/<version>` instead of `omp/<version>`; platforms without a usingopen build still fall back to the upstream release.

### Fixed

- A stale cached `SHA256SUMS.txt` no longer makes the launcher silently fall back to the upstream `omp` binary: it retries with a cache-busted manifest fetch, and a persistent checksum mismatch now fails with a clear error.
- `scripts/install.sh` no longer targets the non-existent `usingopen.com` artifact host: it resolves the newest tag from GitHub, downloads the `usingopen-<platform>-<arch>` release asset (falling back to the upstream `omp-` asset), and verifies it against `SHA256SUMS.txt`.
