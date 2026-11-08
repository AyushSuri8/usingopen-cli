# usingopen

Installs the UsingOpen coding agent — a coding agent with the IDE wired in.

```sh
npm install -g usingopen
```

This package is a launcher, not a runtime. The CLI is a compiled executable, so
`npm install` resolves the newest release, downloads the binary for your platform
(`linux`, `linux-musl`, `darwin`, or `windows`, on `x64` or `arm64`) into
`$XDG_CACHE_HOME/usingopen/bin/<tag>/`, verifies it against the release's
`SHA256SUMS.txt`, and `usingopen` execs it. Node 18.17 or newer is the only
requirement; Bun is not needed.

Binaries come from the published releases at
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/releases). The release
tag is resolved at install time, so the npm package version and the binary
version are independent.

- **Skipped the download** (`npm install --ignore-scripts`): the first run
  fetches the binary instead.
- **Pin a release**: set `USINGOPEN_RELEASE_TAG` (e.g. `v18.18.1`).
- **Mirror**: set `USINGOPEN_DL_BASE` (default
  `https://github.com/can1357/oh-my-pi/releases`). The mirror needs the same
  layout: `<base>/latest` → `<base>/download/<tag>/<asset>` and `SHA256SUMS.txt`.
- **Skip the prefetch**: set `USINGOPEN_SKIP_POSTINSTALL=1`.

Other install methods:

```sh
curl -fsSL https://usingopen.com/install | sh        # macOS / Linux
brew install usingopen/tap/usingopen                  # Homebrew
bun install -g @usingopen/coding-agent                # Bun, from source-asset package
```
