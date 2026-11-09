# usingopen

Installs the UsingOpen coding agent — a coding agent with the IDE wired in.

```sh
npm install -g usingopen
```

This package is a launcher, not a runtime. The CLI is a compiled executable, so
`npm install` resolves the newest release, downloads the binary for your platform
(`linux`, `linux-musl`, `darwin`, or `windows`, on `x64` or `arm64`) into
`$XDG_CACHE_HOME/usingopen/bin/<host>/<tag>/`, verifies it against the release's
`SHA256SUMS.txt`, and `usingopen` execs it. Node 18.17 or newer is the only
requirement; Bun is not needed.

Binaries are built from this repository and published at
[`AyushSuri8/usingopen-cli`](https://github.com/AyushSuri8/usingopen-cli/releases),
so the CLI identifies as `usingopen/<version>`. Platforms this repository does
not build yet fall back to the upstream
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/releases) release, whose
binaries identify as `omp/<version>`. The release tag is resolved at install
time, so the npm package version and the binary version are independent.

- **Skipped the download** (`npm install --ignore-scripts`): the first run
  fetches the binary instead.
- **Pin a release**: set `USINGOPEN_RELEASE_TAG` (e.g. `v18.8.9`).
- **Mirror**: set `USINGOPEN_DL_BASE` (default
  `https://github.com/AyushSuri8/usingopen-cli/releases`). It replaces both
  channels and must serve `usingopen-<platform>-<arch>` assets with the same
  layout: `<base>/latest` → `<base>/download/<tag>/<asset>` and `SHA256SUMS.txt`.
- **Skip the prefetch**: set `USINGOPEN_SKIP_POSTINSTALL=1`.

Source and releases: [`AyushSuri8/usingopen-cli`](https://github.com/AyushSuri8/usingopen-cli).

Other install methods:

```sh
# Prebuilt binary (macOS / Linux)
curl -fsSL https://raw.githubusercontent.com/AyushSuri8/usingopen-cli/main/scripts/install.sh | sh

# Build from a checkout with bun
curl -fsSL https://raw.githubusercontent.com/AyushSuri8/usingopen-cli/main/scripts/install.sh | sh -s -- --source
```
