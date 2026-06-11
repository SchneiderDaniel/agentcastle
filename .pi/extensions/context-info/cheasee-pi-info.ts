/**
 * /cheasee-pi-info — Static castle art command
 *
 * Shows the castle ASCII art that was previously the startup welcome banner.
 * No dynamic data — pure art. Use /explain-* commands for live stats.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Static castle art ────────────────────────────────────────────
// Extracted from the old welcome.ts startup banner, with Session and
// stat lines hardcoded to static values. No dynamic file I/O.

const CASTLE_ART: string[] = [
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
	"                       .@@#=:===%*%%*+#=:   Session:  🟢 Logger  🟢 Advice  #@",
	"                      #@#-:.+%-..                                           %@",
	"                      %%                                                    @@",
	"                      %%   🧩 Extensions: 8  (/explain-extensions)         #@",
	"                      %%   📝 Prompts:    6  (/explain-prompts)            =@",
	"                      %%   🎨 Themes:     3                               #@",
	"                      %%   🔧 Skills:     4  (/explain-skills)             =@",
	"                      %@                                                 ## %@",
	"                      #@*==+**#%@@%#+:.@*%%+-.@*%%=@.@*%%+-. *%%+-==*%%+-. *%%",
	"                      #@*=%==*%%+-.=+**#%%=@.@*%%+-. *%%+-@@%#+:.@*%%+-.@* *%%",
];

export function registerCheaseePiInfo(pi: ExtensionAPI): void {
	pi.registerCommand("cheasee-pi-info", {
		description: "Show castle ASCII art — static info display",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			const art = CASTLE_ART.join("\n");
			ctx.ui.notify(art, "info");
		},
	});
}
