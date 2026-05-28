/**
 * extension-scanner — Scan .pi/extensions/ directories for API usage
 *
 * Legacy regex scanner removed — replaced by AST-based scanExtensionsAST.
 * This file now only provides the Finding interface consumed by issue-builder.
 */

export interface Finding {
	extensionName: string;
	file: string;
	apiName: string;
	line: number;
	lineContent: string;
	changelogVersion: string;
	isBreaking: boolean;
	category: string;
}
