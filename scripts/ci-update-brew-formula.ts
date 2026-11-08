#!/usr/bin/env bun
//
// Render the Homebrew formula for `usingopen` from a published GitHub release and write
// it to a tap checkout. The release publishes per-platform bare binaries
// (usingopen-<platform>-<arch>); this reads their sha256 digests straight from the
// release metadata so the formula never drifts from the shipped assets.
//
// Usage:
//   bun scripts/ci-update-brew-formula.ts <tag> --out <path/to/Formula/usingopen.rb>
//   bun scripts/ci-update-brew-formula.ts v15.10.3        # prints to stdout

const DL_BASE = process.env.USINGOPEN_DL_BASE ?? "https://usingopen.com/dl";
const HOMEPAGE = "https://usingopen.com";
const DESC = "Coding agent with the IDE wired in";

interface ReleaseAsset {
	name: string;
	digest?: string;
}

function parseArgs(argv: readonly string[]): { tag: string; out: string | null } {
	const rest = [...argv];
	let out: string | null = null;
	const outIdx = rest.indexOf("--out");
	if (outIdx >= 0) {
		out = rest[outIdx + 1] ?? null;
		if (!out) throw new Error("--out requires a path");
		rest.splice(outIdx, 2);
	}
	const tag = rest.find(a => !a.startsWith("--"));
	if (!tag) throw new Error("usage: ci-update-brew-formula.ts <tag> [--out <file>]");
	return { tag, out };
}

async function fetchAssets(tag: string): Promise<ReleaseAsset[]> {
	// Closed-source distribution: digests come from the SHA256SUMS file the
	// artifact host publishes next to the release binaries.
	const res = await fetch(`${DL_BASE}/${tag}/SHA256SUMS`);
	if (!res.ok) {
		throw new Error(`failed to fetch ${DL_BASE}/${tag}/SHA256SUMS: HTTP ${res.status}`);
	}
	const text = await res.text();
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line => {
			const [digest, ...rest] = line.split(/\s+/);
			const name = rest.join(" ").replace(/^\*/, "");
			return { name, digest: `sha256:${digest}` } satisfies ReleaseAsset;
		});
}

function sha256For(assets: readonly ReleaseAsset[], name: string): string {
	const asset = assets.find(a => a.name === name);
	if (!asset) throw new Error(`release is missing asset ${name}`);
	if (!asset.digest?.startsWith("sha256:")) {
		throw new Error(`asset ${name} has no sha256 digest (got ${asset.digest ?? "none"})`);
	}
	return asset.digest.slice("sha256:".length);
}

// `${...}` is JS interpolation; the literal `#{version}` / `#{bin}` below are
// Ruby interpolations Homebrew resolves when it evaluates the formula.
export function renderFormula(version: string, sums: Record<string, string>): string {
	// Each `url` carries `using: :nounzip` because the release assets are bare
	// Mach-O/ELF executables, not archives. Without it Homebrew's default
	// CurlDownloadStrategy routes through UnpackStrategy::Uncompressed#extract_nestedly,
	// which nests the file outside the staging CWD; `Dir["usingopen-*"].first` then
	// returns `nil` and `bin.install nil => "usingopen"` raises.
	//
	// `with_env(HOME: buildpath)` redirects the CLI's `os.homedir()` lookup to
	// the writable staging dir so `generate_completions_from_executable` does
	// not touch the real `/Users/<user>/.usingopen` (denied by Homebrew's sandbox
	// profile, which would otherwise fail the popen).
	return `class Usingopen < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${DL_BASE}/v#{version}/usingopen-darwin-arm64",
          using: :nounzip
      sha256 "${sums["usingopen-darwin-arm64"]}"
    end
    on_intel do
      url "${DL_BASE}/v#{version}/usingopen-darwin-x64",
          using: :nounzip
      sha256 "${sums["usingopen-darwin-x64"]}"
    end
  end

  on_linux do
    on_arm do
      url "${DL_BASE}/v#{version}/usingopen-linux-arm64",
          using: :nounzip
      sha256 "${sums["usingopen-linux-arm64"]}"
    end
    on_intel do
      url "${DL_BASE}/v#{version}/usingopen-linux-x64",
          using: :nounzip
      sha256 "${sums["usingopen-linux-x64"]}"
    end
  end

  def install
    bin.install Dir["usingopen-*"].first => "usingopen"
    (bin/"usingopen").chmod 0555
    with_env(HOME: buildpath) do
      generate_completions_from_executable(bin/"usingopen", "completions", shells: [:bash, :zsh, :fish])
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/usingopen --version")
  end
end
`;
}

async function main(): Promise<void> {
	const { tag, out } = parseArgs(process.argv.slice(2));
	const version = tag.replace(/^v/, "");
	const assets = await fetchAssets(tag);

	const targets = ["usingopen-darwin-arm64", "usingopen-darwin-x64", "usingopen-linux-arm64", "usingopen-linux-x64"];
	const sums: Record<string, string> = {};
	for (const name of targets) sums[name] = sha256For(assets, name);

	const formula = renderFormula(version, sums);
	if (out) {
		await Bun.write(out, formula);
		console.log(`wrote ${out} for ${tag}`);
	} else {
		process.stdout.write(formula);
	}
}

if (import.meta.main) {
	await main();
}
