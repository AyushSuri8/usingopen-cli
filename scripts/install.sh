#!/bin/sh
set -e

# USINGOPEN Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AyushSuri8/usingopen-cli/main/scripts/install.sh | sh
#
# Options:
#   --source       Build from a git checkout with bun (installs bun if needed)
#   --binary       Install the prebuilt binary (default)
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

# Source checkout for --source; release assets for the default binary install.
REPO_URL="https://github.com/AyushSuri8/usingopen-cli.git"
DL_BASE="https://github.com/can1357/oh-my-pi/releases"
INSTALL_DIR="${USINGOPEN_INSTALL_DIR:-${PI_INSTALL_DIR:-$HOME/.local/bin}}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install from a git checkout with bun
install_via_bun() {
    echo "Installing via bun from source..."

    if ! has_git; then
        echo "git is required to install from source"
        exit 1
    fi

    # The workspace packages are not published, and bun's global install links
    # the package in place, so the checkout has to outlive this script.
    SRC_DIR="${USINGOPEN_SRC_DIR:-$HOME/.usingopen/src}"
    if [ -d "$SRC_DIR/.git" ]; then
        echo "Updating checkout at $SRC_DIR..."
        (cd "$SRC_DIR" && git fetch --tags origin >/dev/null 2>&1) || {
            echo "Failed to update $SRC_DIR"
            exit 1
        }
        if [ -n "$REF" ]; then
            (cd "$SRC_DIR" && git checkout "$REF" >/dev/null 2>&1) || {
                echo "Failed to check out $REF in $SRC_DIR"
                exit 1
            }
        else
            (cd "$SRC_DIR" && git pull --ff-only >/dev/null 2>&1) || {
                echo "Failed to update $SRC_DIR"
                exit 1
            }
        fi
    else
        echo "Cloning $REPO_URL to $SRC_DIR..."
        mkdir -p "$(dirname "$SRC_DIR")"
        if [ -n "$REF" ]; then
            if ! git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1; then
                git clone "$REPO_URL" "$SRC_DIR"
                (cd "$SRC_DIR" && git checkout "$REF")
            fi
        else
            git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 || {
                echo "Failed to clone $REPO_URL"
                exit 1
            }
        fi
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$SRC_DIR" && git lfs pull)
    fi

    if [ ! -d "$SRC_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${SRC_DIR}/packages/coding-agent"
        exit 1
    fi

    bun install -g "$SRC_DIR/packages/coding-agent" || {
        echo "Failed to install from source"
        exit 1
    }

    echo ""
    echo "✓ Installed usingopen via bun"
    echo "Run 'usingopen' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Resolve the release tag from the releases/latest redirect; an explicit
    # --ref wins.
    if [ -n "$REF" ]; then
        echo "Using release $REF..."
        LATEST="$REF"
    else
        echo "Fetching latest release..."
        LATEST=$(curl -fsSL --connect-timeout 10 --max-time 60 -o /dev/null -w '%{url_effective}' "$DL_BASE/latest" | sed 's#.*/tag/##')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to resolve release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download the release asset
    BINARY_URL="${DL_BASE}/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/usingopen"
    chmod +x "${INSTALL_DIR}/usingopen"

    # Verify the download against the published SHA256SUMS when the host serves
    # one (all release artifacts ship together); skip with a warning otherwise.
    if CHECKSUMS=$(curl -fsSL --connect-timeout 10 --max-time 60 "${DL_BASE}/download/${LATEST}/SHA256SUMS.txt" 2>/dev/null); then
        EXPECTED=$(printf '%s\n' "$CHECKSUMS" | awk -v asset="$BINARY" '$2 == asset { print $1; exit }')
        if [ -n "$EXPECTED" ] && command -v sha256sum >/dev/null 2>&1; then
            ACTUAL=$(sha256sum "${INSTALL_DIR}/usingopen" | cut -d' ' -f1)
            if [ "$ACTUAL" != "$EXPECTED" ]; then
                echo "✗ Checksum mismatch for ${BINARY}: expected ${EXPECTED}, got ${ACTUAL}"
                exit 1
            fi
            echo "✓ Checksum verified"
        else
            echo "Warning: no checksum entry for ${BINARY}; skipping verification"
        fi
    else
        echo "Warning: SHA256SUMS.txt unavailable; skipping verification"
    fi

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/usingopen" --version 2>&1)"; then
        echo ""
        echo "✗ usingopen was downloaded to ${INSTALL_DIR}/usingopen but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'usingopen':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    echo ""
    echo "✓ Installed usingopen to ${INSTALL_DIR}/usingopen"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'usingopen' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'usingopen'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: the published release binary. It needs no toolchain and is
        # checksum-verified; --source opts into the bun build from a checkout.
        install_binary
        ;;
esac
