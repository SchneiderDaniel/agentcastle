// ─── Package Safety Check ──────────────────────────────────────────
// Deterministic package age validation for npm install safety.
// Extracted from LLM-instructed agent prompts into stable TypeScript code.
//
// The 14-day safety threshold protects against typosquatting and
// dependency confusion attacks by blocking packages published less
// than 14 days ago.

/** Safety threshold in days — packages younger than this are blocked. */
export const SAFETY_THRESHOLD_DAYS = 14;

/** Result of a package age check. */
export interface PackageAgeResult {
	/** Whether the package is safe to install. */
	safe: boolean;
	/** Age of the package in whole days. */
	ageDays: number;
	/** Whether the package should be blocked (equivalent to !safe). */
	blocked: boolean;
}

/**
 * Parse a date string into a Date object.
 * Returns null for unparseable/null/undefined/empty inputs.
 */
function parseDate(dateStr: string | null | undefined): Date | null {
	if (dateStr === null || dateStr === undefined || dateStr === "") return null;
	const date = new Date(dateStr);
	if (isNaN(date.getTime())) return null;
	return date;
}

/**
 * Calculate the age in whole days between a date and now.
 */
function daysSince(date: Date): number {
	const now = Date.now();
	const diffMs = now - date.getTime();
	return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Check whether a package specifier is exempt from age checking.
 * Exempt: git URLs, tarballs, local paths.
 */
function isExempt(packageSpecifier: string): boolean {
	// git URL patterns
	if (
		packageSpecifier.startsWith("git+") ||
		packageSpecifier.startsWith("git:") ||
		packageSpecifier.startsWith("git@") ||
		packageSpecifier.startsWith("ssh:")
	) {
		return true;
	}

	// URL-based packages (tarballs, hosted packages)
	if (
		packageSpecifier.startsWith("http://") ||
		packageSpecifier.startsWith("https://") ||
		packageSpecifier.startsWith("file:")
	) {
		return true;
	}

	// Local paths (starting with ./, ../, or /)
	if (
		packageSpecifier.startsWith("./") ||
		packageSpecifier.startsWith("../") ||
		packageSpecifier.startsWith("/")
	) {
		return true;
	}

	return false;
}

/**
 * Build a blocked message for a package that failed the age check.
 */
function buildBlockedMessage(packageName: string, ageDays: number): string {
	return `Package ${packageName} is ${ageDays} days old — below ${SAFETY_THRESHOLD_DAYS}-day safety threshold. Cannot install.`;
}

/**
 * Calculate whether a package is safe based on its creation date.
 * Fail-closed: invalid/missing date → blocked.
 */
function calculate(createdDate: string | null | undefined): PackageAgeResult {
	const date = parseDate(createdDate);
	if (date === null) {
		// Fail closed: unparseable date → blocked
		return { safe: false, ageDays: 0, blocked: true };
	}

	const age = daysSince(date);
	if (age < SAFETY_THRESHOLD_DAYS) {
		return { safe: false, ageDays: age, blocked: true };
	}

	return { safe: true, ageDays: age, blocked: false };
}

/**
 * Package safety check with all methods exposed for testing and composition.
 */
export const checkPackageAge = {
	parseDate,
	daysSince,
	isExempt,
	calculate,
	buildBlockedMessage,
};

/**
 * Run a full package safety check from an npm view time.created string.
 * This is the main entry point for agent use.
 *
 * Steps:
 * 1. Check if package specifier is exempt (git URL, tarball, local path)
 * 2. Parse the date string from `npm view <pkg> time.created`
 * 3. Calculate age and determine safety
 *
 * @param packageName - The npm package name or specifier
 * @param createdDate - The result of `npm view <pkg> time.created` (ISO date string)
 * @returns PackageAgeResult with safe/blocked status
 */
export function runPackageSafetyCheck(
	packageName: string,
	createdDate: string | null | undefined,
): PackageAgeResult {
	// Exempt packages bypass the age check
	if (isExempt(packageName)) {
		return { safe: true, ageDays: 0, blocked: false };
	}

	return calculate(createdDate);
}
