/**
 * Apify website-content-crawler fallback.
 *
 * External service boundary — falls back silently if APIFY_TOKEN missing.
 * Signature unchanged from monolith: apifyCrawl(url, maxPages, signal).
 */

/**
 * Attempt to crawl via Apify's website-content-crawler actor.
 * Returns markdown string or null (no token / failure).
 */
export async function apifyCrawl(
	url: string,
	maxPages: number,
	signal?: AbortSignal,
): Promise<string | null> {
	const token = process.env.APIFY_TOKEN;
	if (!token) return null;

	// Use Apify's official website-content-crawler (5.0 rating, actively maintained).
	const actorId = "apify~website-content-crawler";
	const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=120`;

	try {
		// 130s client timeout — slightly above server's 120s timeout param.
		// Combined with external cancellation signal prevents hang before reaching Apify.
		const fetchSignal = signal
			? AbortSignal.any([AbortSignal.timeout(130_000), signal])
			: AbortSignal.timeout(130_000);
		const res = await fetch(apiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				startUrls: [{ url }],
				maxCrawlPages: maxPages,
				maxCrawlDepth: 0,
				outputFormat: "markdown",
				sameDomainOnly: true,
			}),
			signal: fetchSignal,
		});

		if (!res.ok) return null;
		const items = (await res.json()) as Array<Record<string, unknown>>;
		const texts = items.map((item) => {
			const u = String(item.url ?? url);
			const body = String(
				item.markdown ?? item.text ?? item.content ?? JSON.stringify(item, null, 2),
			);
			return `--- ${u} ---\n${body}`;
		});
		return texts.join("\n\n") || null;
	} catch {
		return null;
	}
}
