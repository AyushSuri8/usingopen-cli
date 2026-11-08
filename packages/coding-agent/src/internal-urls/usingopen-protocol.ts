/**
 * Protocol handler for usingopen:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - usingopen:// - Lists all available documentation files
 * - usingopen://<file>.md - Reads a specific documentation file
 */
import usingopenDoc from "../prompts/internal-urls/usingopen.md" with { type: "text" };
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import { usingopenDocFilename, usingopenDocRel, usingopenDocsScopeEntries } from "./usingopen-scope";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/**
 * Handler for usingopen:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class UsingopenProtocolHandler implements ProtocolHandler {
	readonly scheme = "usingopen";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };

	/** Always advertised: harness docs are embedded in every build. */
	promptDoc(): string {
		return usingopenDoc.trim();
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const filename = usingopenDocFilename(url);
		// The docs root (`usingopen://`, `usingopen://docs`) names no doc. The grammar also
		// rejects absolute paths and `..` traversal.
		const docPath = usingopenDocRel(url);

		if (!filename || !docPath) {
			return this.#listDocs(url);
		}

		return this.#readDoc(docPath, filename, url);
	}

	/** The docs root expands to every embedded doc; a single-doc URL yields that doc (or throws when unknown). */
	async enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const docPath = usingopenDocRel(url);
		if (!docPath) {
			const entries = await usingopenDocsScopeEntries(context);
			if (entries.length === 0) {
				throw new Error("No documentation files found");
			}
			return entries;
		}
		const resource = await this.#readDoc(docPath, usingopenDocFilename(url), url);
		return [{ url: `usingopen://${docPath}`, content: resource.content }];
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const filenames = getDocFilenames();
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](usingopen://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(docPath: string, filename: string, url: InternalUrl): Promise<InternalResource> {
		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse usingopen:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
