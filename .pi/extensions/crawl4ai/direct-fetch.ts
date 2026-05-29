/**
 * Fallback lightweight HTML-to-markdown converter + direct HTTP fetch crawler.
 *
 * Pure functions — no pi dependency, testable without any infra.
 * Used as last resort when crawl4ai + Apify both fail.
 */

/**
 * Convert HTML string to rough markdown using regex-based transformations.
 * Pure function, no side effects.
 */
export function htmlToMarkdown(html: string): string {
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<header[\s\S]*?<\/header>/gi, "")
		.replace(/<aside[\s\S]*?<\/aside>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	text = text.replace(/<(\/?)(p|div|section|article|main|blockquote)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)(h[1-6])[^>]*>/gi, (_m, _slash, tag) => {
		const level = parseInt(tag[1], 10);
		return "\n" + "#".repeat(level) + " ";
	});
	text = text.replace(/<(\/?)(ul|ol)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)li[^>]*>/gi, "\n- ");
	text = text.replace(/<(\/?)(tr|br)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)(td|th)[^>]*>/gi, " | ");
	text = text.replace(
		/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href, inner) => `[${inner.replace(/<[^>]+>/g, "").trim()}](${href})`,
	);
	text = text.replace(/<(\/?)(strong|b)[^>]*>/gi, "**");
	text = text.replace(/<(\/?)(em|i)[^>]*>/gi, "_");
	text = text.replace(/<(\/?)code[^>]*>/gi, "`");
	text = text.replace(/<(\/?)pre[^>]*>/gi, "\n```\n");
	text = text.replace(/<[^>]+>/g, "");
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(\d+);/g, (_m, num) => String.fromCharCode(parseInt(num, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
	return text
		.split("\n")
		.map((l) => l.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Build a human-readable HTTP error string with differentiated messages.
 */
function httpErrorMessage(status: number): string {
	if (status === 401) {
		return `HTTP 401 Unauthorized — check API key/auth headers`;
	}
	if (status === 403) {
		return `HTTP 403 Forbidden`;
	}
	return `HTTP ${status}`;
}

/**
 * Last-resort crawl: direct HTTP fetch + regex-based HTML-to-markdown conversion.
 * No external dependencies beyond fetch (global in Node 18+).
 *
 * Signature: (url, maxPages, signal) — no onUpdate (unused, removed).
 */
export async function directFetchCrawl(
	url: string,
	maxPages: number,
	signal?: AbortSignal,
): Promise<string> {
	const visited = new Set<string>();
	const queue: string[] = [url];
	const results: string[] = [];

	while (queue.length > 0 && visited.size < maxPages) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);

		try {
			const res = await fetch(current, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
						"AppleWebKit/537.36 (KHTML, like Gecko) " +
						"Chrome/120.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
				signal,
			});

			if (!res.ok) {
				results.push(`--- ${current} ---\nError: ${httpErrorMessage(res.status)}`);
				continue;
			}

			const contentType = res.headers.get("content-type") || "";
			if (!contentType.includes("text/html")) {
				const snippet = await res.text();
				results.push(`--- ${current} ---\n[Non-HTML: ${contentType}]\n${snippet.slice(0, 800)}`);
				continue;
			}

			const html = await res.text();
			const md = htmlToMarkdown(html);
			results.push(`--- ${current} ---\n${md || "[No extractable content]"}`);

			if (visited.size < maxPages) {
				const base = new URL(current);
				const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
				let m: RegExpExecArray | null;
				while ((m = regex.exec(html)) !== null) {
					try {
						const link = new URL(m[1], current).href;
						if (new URL(link).origin !== base.origin) continue;
						const clean = link.split("#")[0];
						if (!visited.has(clean) && !queue.includes(clean)) queue.push(clean);
					} catch {
						// ignore
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push(`--- ${current} ---\nError: ${msg}`);
		}
	}

	return results.join("\n\n") || "Crawl completed but no content was extracted.";
}
