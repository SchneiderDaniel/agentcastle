/**
 * ranked-map — Query term expansion
 *
 * Pure module — no pi SDK imports. Pure functions only, zero I/O.
 * Expands natural-language query terms into regex patterns for ripgrep,
 * bridging the gap between agent queries and codebase naming conventions.
 *
 * Expansion rules applied to each term:
 * - Strip common suffixes (-ion, -ed, -ing, -ate, -ify, -ment)
 * - Add first-N shorthand (4 chars for words > 5, 3 chars for words > 4)
 * - Add plurals
 * - Add -ed, -ing, -s derivations
 * - Keep original term
 *
 * Synonyms from config are merged into the expanded pattern.
 */

/**
 * Reciprocal suffix mappings for deriving alternate forms.
 *
 * Each entry: if term ends with `suffix`, also add all `variants` to the set.
 * This handles noun↔verb mappings like authentication→authenticate.
 */
const RECIPROCAL_SUFFIXES: { suffix: string; getVariants: (root: string) => string[] }[] = [
	// -cation → -cate (authentication → authenticate)
	{
		suffix: "cation",
		getVariants: (root) => [root + "cate"],
	},
	// -sation → -se (compensation → compense... rare but safe)
	{
		suffix: "sation",
		getVariants: (root) => [root + "se"],
	},
	// -ation → -ate  (authentication → authentic → authenticate)
	// Actually we handle this after stripping the full suffix
	{
		suffix: "ification",
		getVariants: (root) => [root + "ify", root + "ifies", root + "ified"],
	},
	// -ization → -ize
	{
		suffix: "ization",
		getVariants: (root) => [root + "ize", root + "izes", root + "ized", root + "izing"],
	},
	// -ion → root + e (e.g. action → acte... no, action → act)
	// Actually action strip ion → act, add nothing.
	// But authentication strip ation → authentic, add e → authenticate
];

/**
 * Expand a single query term into a regex alternation pattern.
 *
 * Derives code-common variants:
 * - Original term (always)
 * - Plural (adds "s" or "es")
 * - -ed and -ing forms
 * - Stripped suffix root + derivations
 * - First-N character shorthand
 *
 * Returns a string like "(authentication|authenticate|auth)".
 * Returns empty string for empty input.
 */
export function expandTerm(term: string): string {
	const trimmed = term.trim();
	if (!trimmed) return "";

	const variants = new Set<string>();
	variants.add(trimmed);

	// Step 1: Add plural forms
	addPlural(trimmed, variants);

	// Step 2: Add verb derivations (-ed, -ing)
	addVerbDerivations(trimmed, variants);

	// Step 3: Strip known nominal suffixes to find verb roots
	tryStripIonSuffixes(trimmed, variants);
	tryStripMentSuffix(trimmed, variants);
	tryStripIfySuffix(trimmed, variants);

	// Step 4: If term ends in -ate, add -ion form
	tryAddIonFromAte(trimmed, variants);

	// Step 5: Add first-N character shorthand
	addShortHand(trimmed, variants);

	// Remove empty strings and duplicates, then build regex alternation group
	const parts = [...variants].filter(Boolean).sort();
	if (parts.length === 0) return `(${trimmed})`;
	if (parts.length === 1) return `(${parts[0]})`;
	return `(${parts.join("|")})`;
}

/**
 * Add plural(s) for a term.
 */
function addPlural(term: string, variants: Set<string>): void {
	if (term.endsWith("y") && term.length > 2 && !/[aeiou]y$/i.test(term)) {
		// consonant + y → ies
		variants.add(term.slice(0, -1) + "ies");
	} else if (term.length >= 2 && !term.endsWith("s")) {
		variants.add(term + "s");
		// es forms for certain endings
		if (/[shxzo]$/i.test(term) && !term.endsWith("sh") && !term.endsWith("ch")) {
			variants.add(term + "es");
		}
	}
}

/**
 * Add -ed and -ing verb derivations.
 */
function addVerbDerivations(term: string, variants: Set<string>): void {
	if (term.endsWith("ed") && term.length > 3) {
		// Term already ends in -ed — derive root and variants
		const root = term.slice(0, -2);
		if (root.length >= 2) {
			variants.add(root);
			variants.add(root + "s");
			if (root.endsWith("e")) {
				variants.add(root.slice(0, -1) + "ing");
			} else {
				variants.add(root + "ing");
				// If root doesn't end in e, add root + e (e.g. cach → cache)
				const withE = root + "e";
				variants.add(withE);
				variants.add(withE + "s");
				variants.add(withE + "d");
			}
		}
	} else if (term.endsWith("ing") && term.length > 4) {
		// Term ends in -ing — derive root
		const root = term.slice(0, -3);
		if (root.length >= 2) {
			variants.add(root);
			variants.add(root + "s");
			variants.add(root + "ed");
		}
		// Also try with trailing e added (caching → cache)
		const withE = root + "e";
		if (withE.length >= 2) {
			variants.add(withE);
			variants.add(withE + "s");
			variants.add(withE + "d");
		}
	} else if (term.endsWith("e") && term.length > 2) {
		// Term ends in e — standard verb forms
		variants.add(term + "d");
		variants.add(term.slice(0, -1) + "ing");
	} else if (term.length > 3) {
		// Standard verb forms (skip for very short terms like "run", "set")
		variants.add(term + "ed");
		variants.add(term + "ing");
	}
}

/**
 * Try stripping -ion family suffixes to get verb roots.
 * e.g. authentication → authenticate, authorization → authorize
 */
function tryStripIonSuffixes(term: string, variants: Set<string>): void {
	// Try longer suffixes first (greedy match)
	const ionSuffixes = [
		{
			suffix: "ification",
			reconstruct: (r: string) => [r + "ify", r + "ifies", r + "ified", r + "ifying"],
		},
		{
			suffix: "ization",
			reconstruct: (r: string) => [r + "ize", r + "izes", r + "ized", r + "izing"],
		},
		{
			suffix: "isation",
			reconstruct: (r: string) => [r + "ise", r + "ises", r + "ised", r + "ising"],
		},
		{
			suffix: "cation",
			reconstruct: (r: string) => [r + "cate", r + "cates", r + "cated", r + "cating"],
		},
		{ suffix: "sation", reconstruct: (r: string) => [r + "se", r + "ses", r + "sed", r + "sing"] },
		{
			suffix: "ation",
			reconstruct: (r: string) => [r + "ate", r + "ates", r + "ated", r + "ating"],
		},
		{ suffix: "ition", reconstruct: (r: string) => [r + "ite"] },
		{ suffix: "sion", reconstruct: (r: string) => [r] },
		{ suffix: "tion", reconstruct: (r: string) => [r + "te"] },
		{ suffix: "ion", reconstruct: (r: string) => [r, r + "e"] },
	];

	for (const { suffix, reconstruct } of ionSuffixes) {
		if (term.endsWith(suffix) && term.length > suffix.length + 1) {
			const root = term.slice(0, -suffix.length);
			for (const variant of reconstruct(root)) {
				if (variant.length >= 2) {
					variants.add(variant);
				}
			}
			return; // Only first match
		}
	}
}

/**
 * Try stripping -ment suffix.
 * e.g. deployment → deploy
 */
function tryStripMentSuffix(term: string, variants: Set<string>): void {
	if (term.endsWith("ment") && term.length > 5) {
		const root = term.slice(0, -4);
		if (root.length >= 2) {
			variants.add(root);
			variants.add(root + "s");
			variants.add(root + "ed");
			variants.add(root + "ing");
		}
	}
}

/**
 * Try stripping -ify suffix.
 * e.g. verify → verification, verifies, verified, verifying
 */
function tryStripIfySuffix(term: string, variants: Set<string>): void {
	if (term.endsWith("ify") && term.length > 4) {
		// Strip 'y' to get the base (e.g. "verify" → "verif")
		const base = term.slice(0, -1);
		if (base.length >= 2) {
			variants.add(base + "ication"); // verification
			variants.add(base + "ies"); // verifies
			variants.add(base + "ied"); // verified
			variants.add(base + "ying"); // verifying
		}
	}
}

/**
 * If term ends in -ate, try adding -ion noun forms.
 * e.g. authenticate → authentication
 */
function tryAddIonFromAte(term: string, variants: Set<string>): void {
	if (term.endsWith("ate") && term.length > 4) {
		const root = term.slice(0, -3); // e.g. "authentic" from "authenticate"
		if (root.length >= 2) {
			variants.add(root + "ation");
			variants.add(root + "ations");
		}
	}
}

/**
 * Add first-N character shorthand.
 * For words > 5 chars: first 4 chars
 * For words > 4 chars: first 3 chars
 */
function addShortHand(term: string, variants: Set<string>): void {
	if (term.length > 5) {
		variants.add(term.slice(0, 4));
	} else if (term.length > 4) {
		variants.add(term.slice(0, 3));
	}
	// Also try first-3 for longer words if first-4 is too close to full word
	if (term.length >= 6) {
		variants.add(term.slice(0, 3));
	}
}

/**
 * Expand a full query (space-separated terms) into an array of expanded
 * regex patterns, one per original term.
 *
 * When synonyms are provided (from .pi/settings.json rankedMap.synonyms),
 * they are merged into the expansion for matching terms.
 *
 * @param query - Space-separated query string
 * @param synonyms - Optional map of term → synonym array from config
 * @returns Array of expanded regex patterns, one per query term
 */
export function expandQuery(query: string, synonyms?: Record<string, string[]>): string[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const terms = trimmed.split(/\s+/).filter(Boolean);

	return terms.map((term) => {
		const expanded = expandTerm(term);

		// If no synonyms for this term, return expanded pattern as-is
		if (!synonyms || !synonyms[term] || synonyms[term]!.length === 0) {
			return expanded;
		}

		// Merge synonyms into the expanded pattern
		const syns = synonyms[term]!;
		// Extract existing variants from the expanded pattern
		// Pattern is like "(variant1|variant2|...)"
		const innerContent = expanded.startsWith("(") ? expanded.slice(1, -1) : expanded;
		const existingVariants = new Set(innerContent.split("|"));

		for (const syn of syns) {
			if (!existingVariants.has(syn)) {
				existingVariants.add(syn);
			}
		}

		const merged = [...existingVariants].sort();
		return `(${merged.join("|")})`;
	});
}
