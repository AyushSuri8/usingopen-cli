# macOS signing & notarization

**UsingOpen ships unsigned macOS binaries.** There is no Apple Developer
account budget for a Developer ID Application certificate or notarization, so
the release pipeline performs **no signing at all** — the `Sign macOS binary`
step in `.github/workflows/ci.yml` is skipped unless the five `APPLE_*` secrets
are configured. This document covers what that means for users, what still
works, and what to do if signing is ever funded.

## What Gatekeeper does with unsigned binaries

An unsigned binary downloaded through a path that sets the **quarantine**
attribute (a browser download, some chat/file transfers, a Homebrew **cask**)
is blocked by Gatekeeper on first launch. Distribution paths that do **not**
quarantine are unaffected:

| Install path | Gatekeeper consulted? | Why |
| --- | --- | --- |
| `curl -fsSL https://usingopen.com/dl/install.sh \| sh` | No | `curl` sets no quarantine bit |
| `irm https://usingopen.com/dl/install.ps1 \| iex` | No | Windows (SmartScreen, not Gatekeeper) |
| Homebrew **formula** (internal tap) | No | Homebrew does not quarantine formula files |
| Browser download of `usingopen-darwin-<arch>` | **Yes** | Quarantine attribute is set |

For the quarantined case, the user-facing mitigation (documented in the
release notes) is one of:

1. **Right-click → Open** the binary (or the `.app`/folder containing it) on
   first launch, then confirm in the dialog. Subsequent launches are normal.
2. Remove the quarantine attribute explicitly:
   `xattr -d com.apple.quarantine /path/to/usingopen`
3. `spctl --master-disable` (full Gatekeeper disable) — not recommended.

The binary itself runs correctly once launched: the unsigned build keeps Bun's
original signature state, and `release_smoke` still runs `--version` and
`--smoke-test` on real macOS hardware before anything publishes.

## Optional: enabling Developer ID signing later

The signing pipeline is retained and only needs the secrets below to engage. If
signing is ever funded, configure all five `APPLE_*` repository secrets and the
existing `scripts/ci-macos-sign.sh` path activates automatically: the sign step
runs, `release_smoke` asserts a non-ad-hoc signature again, and the binaries
ship Developer ID–signed and notarized. Nothing else in the release process
changes.

### Why the entitlements are mandatory (when signing is enabled)

The binary is a Bun single-file executable that also launches Xcode's MCP
bridge, so the hardened runtime needs:

| Entitlement                                              | Reason                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore JITs at runtime.                                                                                                                                                                                                                                                                                               |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC executable memory pages.                                                                                                                                                                                                                                                                                                  |
| `com.apple.security.automation.apple-events`             | Allows macOS to prompt for Automation permission when `xcrun mcpbridge` connects to Xcode; without it, first-time Xcode MCP initialization hangs until timeout.                                                                                                                                                                |
| `com.apple.security.cs.disable-library-validation`       | usingopen extracts its native addon (`pi_natives.<triple>.node`) and other optional dylibs to a runtime cache and `dlopen()`s them. They do not share the main binary's Team ID, so without this the hardened runtime aborts with _"mapping process and mapped file have different Team IDs"_ — breaking effectively every command. |

Without `disable-library-validation`, a signed+notarized binary signs and
notarizes fine but **fails at first real use**. `release_smoke` runs
`--smoke-test` under the shipped signature specifically to catch this before
anything publishes.

### Stapling limitation (only relevant if signing is enabled)

A bare Mach-O executable **cannot be stapled** (`stapler` only supports
`.app`/`.pkg`/`.dmg`). A signed binary is genuinely notarized — the notary
service returns `Accepted` and the ticket exists on Apple's servers keyed to its
cdhash — but the ticket must be fetched online rather than read from the
executable. Unsigned builds skip this entirely: there is no ticket, and
Gatekeeper must be satisfied locally (right-click → Open, per above).

## Optional signing secrets (not configured)

Add these under the CI system's secret settings only if signing is ever
funded. All five secrets (cert, password, and API key trio) must be present for
signing to engage.

| Secret                       | What it is                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | base64 of the exported Developer ID Application `.p12` (cert + private key). |
| `APPLE_CERTIFICATE_PASSWORD` | password you set when exporting the `.p12`.                                  |
| `APPLE_API_KEY_ID`           | App Store Connect API **Key ID**.                                            |
| `APPLE_API_ISSUER_ID`        | App Store Connect API **Issuer ID** (UUID).                                  |
| `APPLE_API_KEY`              | base64 of the App Store Connect `.p8` private key.                           |

### Producing the credential files

Drop these into a working directory (default `~/usingopen-signing`):

| File                 | How                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.p12`              | **Keychain Access** → right-click your _Developer ID Application: …_ identity (the entry that expands to a cert **with** a private key) → **Export…** → save as `.p12` and set a password.                                              |
| `p12-password.txt`   | the password you just set on the `.p12`.                                                                                                                                                                                                |
| `AuthKey_<KEYID>.p8` | App Store Connect → **Users and Access → Integrations → App Store Connect API** → create a key (**Account Holder** role also allows API cert creation; **Developer** is enough for notarization) → **download once** (non-recoverable). |
| `issuer-id.txt`      | the **Issuer ID** (UUID) shown above the keys table.                                                                                                                                                                                    |
| `key-id.txt`         | _optional_ — the Key ID; otherwise read from the `.p8` filename.                                                                                                                                                                        |

The App Store Connect API key is the one credential that **cannot** be minted
from a CLI — it is the bootstrap credential for the API itself, and the `.p8`
downloads exactly once. Everything else is local.

### Uploading credential files

`scripts/ci-macos-upload-secrets.sh` requires exactly one `.p12` and one `.p8`,
imports the certificate into a temporary keychain to verify its password and
Developer ID identity, and checks that the `.p8` contains a PEM private-key
header. It pipes each uploaded value to the CI secret store over stdin rather
than putting it in command arguments or printing the credential payloads. Validation
does pass the certificate password to `security import -P`, so the password
can appear in that subprocess's arguments. The script prints the filenames
and Key ID.

```sh
scripts/ci-macos-upload-secrets.sh ~/usingopen-signing --dry-run   # validate first
scripts/ci-macos-upload-secrets.sh ~/usingopen-signing             # upload all five
gh secret list --repo usingopen/usingopen                       # confirm
```

Re-run it whenever the certificate is renewed. `USINGOPEN_SIGNING_DIR` changes the
default input directory; `USINGOPEN_REPO=owner/repo` changes the target
repository. The validation path requires macOS `security`; uploading also
requires an authenticated CI CLI.

### Finding your signing identity / Team ID (sanity check)

```sh
security find-identity -v -p codesigning
# e.g. "Developer ID Application: Your Name (TEAMID1234)"
```

The `.p12` carries a single identity, which rcodesign signs with; you do not
need to store the identity string or Team ID as a secret.

## Local dry run

You can exercise the full sign+notarize path on a Linux machine (real cert +
API key) by exporting the five env vars and running:

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/usingopen-darwin-arm64
```

With no env vars configured the CI skips signing entirely and ships the
unsigned binary (the current UsingOpen configuration); the Gatekeeper
mitigations above apply.
