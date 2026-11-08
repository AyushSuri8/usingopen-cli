import { type ReactNode, useId } from "react";

/** The UsingOpen U mark, same glyph as the OAuth page, filled with the brand gradient. */
export function UsingopenMark({ size = 22 }: { size?: number }): ReactNode {
	const gradient = `usingopen-mark-${useId().replace(/:/g, "")}`;
	return (
		<svg className="sh-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" style={{ stopColor: "var(--mark-a)" }} />
					<stop offset=".5" style={{ stopColor: "var(--mark-b)" }} />
					<stop offset="1" style={{ stopColor: "var(--mark-c)" }} />
				</linearGradient>
			</defs>
			<path fill={`url(#${gradient})`} d="M14 14h9v31h18V14h9v40H14z" />
		</svg>
	);
}
