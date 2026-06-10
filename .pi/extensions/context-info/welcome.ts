/**
 * Startup welcome banner widget for context-info extension
 *
 * Shows castle art and extension/prompt/theme/skill counts on session start.
 * All file I/O is deferred to function execution time.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countExtensions } from "./extensions.js";
import { countSkills } from "./skills.js";

// ── Shared extension state (file-based to avoid dual-module hazard) ──

const STATE_PATH = ".pi/state/session-extensions.json";

interface SessionExtState {
	logger: boolean | null;
	advice: boolean | null;
}

/**
 * Read session extension state from shared file.
 * Returns null for missing keys.
 */
export function readSessionExtState(): SessionExtState {
	try {
		const raw = readFileSync(STATE_PATH, "utf-8");
		const data = JSON.parse(raw);
		return {
			logger: typeof data.logger === "boolean" ? data.logger : null,
			advice: typeof data.advice === "boolean" ? data.advice : null,
		};
	} catch {
		return { logger: null, advice: null };
	}
}

function listNames(dir: string, suffix: string): string[] {
	try {
		if (!existsSync(dir)) return [];
		const results: string[] = [];
		const walk = (d: string) => {
			const entries = readdirSync(d, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = joinPath(d, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "." && entry.name !== "..") {
						walk(fullPath);
					}
				} else if (entry.isFile() && entry.name.endsWith(suffix)) {
					results.push(entry.name.replace(new RegExp(`${suffix.replace(".", "\\.")}$`), ""));
				}
			}
		};
		walk(dir);
		return results.sort();
	} catch {
		return [];
	}
}

export function showWelcomeBanner(
	ctx: ExtensionContext,
	startupWidgetActive: { value: boolean },
	sessionId: string,
	loggerState?: boolean | null,
	adviceState?: boolean | null,
): void {
	const extCount = countExtensions();
	const promptCount = listNames(".pi/prompts", ".md").length;
	const themeCount = listNames(".pi/themes", ".json").length;
	const skillCount = countSkills();

	ctx.ui.setWidget("agentcastle-welcome", (_tui, theme) => {
		return {
			dispose() {},
			invalidate() {},
			render(_width: number): string[] {
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const accent = (s: string) => theme.fg("accent", s);

				const baseW = 88;

				// ── Centered title ────────────────────────
				const titleText = "\ud83c\udff0 Agent Castle";
				const titleVis = visibleWidth(titleText);
				const titlePad = Math.max(0, Math.floor((baseW - titleVis) / 2));
				const titleLine =
					" ".repeat(titlePad) + accent(titleText) + " ".repeat(baseW - titlePad - titleVis);

				// ── Session ID line ─────────────────────────
				const sidLabel = muted("SessionID: ");
				const sidValue = accent(sessionId);
				const sidRawW = visibleWidth("SessionID: ") + visibleWidth(sessionId);
				const sidPad = Math.max(0, Math.floor((baseW - sidRawW) / 2));
				const sidLine =
					" ".repeat(sidPad) +
					sidLabel +
					sidValue +
					" ".repeat(Math.max(0, baseW - sidPad - sidRawW));

				// ── Castle art with stats embedded ──────────
				const lIcon = loggerState == null ? "❓" : loggerState ? "🟢" : "🔴";
				const aIcon = adviceState == null ? "❓" : adviceState ? "🟢" : "🔴";

				const castle: string[] = [
					"                                                #@@@%+:",
					"                                              %@#===+#%@@@#:",
					"                                             %@+=========+*%@@#.",
					"                                            #@======------====#%@#:",
					"                                          :#@+==========-----====*%@%:",
					"                                        :#@#===+@@%*+=======--:-====*%@*.",
					"                                      -#@*=======+*#@@%*+=====--======+#@%-",
					"                                    =@@*=============+*%@%+-=======++**==*%%",
					"                                  =%%*==================+**====+#%@@#*=    #@",
					"                                +%%*=========================*@@+.         @=",
					"                              -*#=:---================+*#%%@@@=             @%",
					"                            =#*-:--:-=====-:::-==*#+%@+==.                  %@",
					"                         .#%+=::-:-==:*#%@#+%@%+.                           #@",
					`                       .@@#=:===%*%%*+#=:   ${muted("Session:")} ${lIcon} ${accent("Logger")}  ${aIcon} ${accent("Advice")}  #@`,
					"                      #@#-:.+%-..                                           %@",
					"                      %%                                                    @@",
					`                      %%   ${muted("🧩 Extensions:")} ${accent(String(extCount))} ${dim("(/explain-extensions)")}         #@`,
					`                      %%   ${muted("📝 Prompts:")}    ${accent(String(promptCount))} ${dim("(/explain-prompts)")}            =@`,
					"                      %%   " +
						muted("🎨 Themes:") +
						"      " +
						accent(String(themeCount)) +
						"                               #@",
					"                      %%   " +
						muted("🔧 Skills:") +
						"      " +
						accent(String(skillCount)) +
						" " +
						dim("(/explain-skills)") +
						"             =@",
					"                      %@                                                 ## %@",
					"                      #@*==+**#%@@%#+:.@*%%+-.@*%%=@.@*%%+-. *%%+-==*%%+-. *%%",
					"                      #@*=%==*%%+-.=+**#%%=@.@*%%+-. *%%+-@@%#+:.@*%%+-.@* *%%",
				];

				// Pad all castle lines to baseW
				const castleLines = castle.map((line) => {
					const w = visibleWidth(line);
					return dim(w < baseW ? line + " ".repeat(baseW - w) : line);
				});

				return [titleLine, sidLine, "", ...castleLines];
			},
		};
	});
	startupWidgetActive.value = true;
}
