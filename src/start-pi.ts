#!/usr/bin/env node
/**
 * pi startup wrapper — AgentCastle entry point.
 *
 * This module patches `DefaultResourceLoader.prototype.reload` with splash
 * integration BEFORE pi's main() runs. This ensures the loading screen
 * appears during extension startup.
 *
 * Usage:
 *   node --experimental-strip-types src/start-pi.ts [args...]
 *
 * Or add an npm script:
 *   "pi": "node --experimental-strip-types src/start-pi.ts"
 *
 * The wrapper:
 *   1. Calls setupSplashIntegration() — patches DefaultResourceLoader to show
 *      a splash screen during extension loading and emit progress events.
 *   2. Calls main() from @earendil-works/pi-coding-agent — starts pi normally.
 *
 * All CLI arguments are forwarded to pi's main().
 */

import { setupSplashIntegration } from "./integrate-splash.js";
import { main } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 1. Patch DefaultResourceLoader with splash integration
// ---------------------------------------------------------------------------
// This must happen BEFORE any DefaultResourceLoader is instantiated.
// setupSplashIntegration() replaces reload() with a version that:
//   - Renders a splash screen with spinner during extension loading
//   - Emits extension_loading_progress events via the event bus
//   - Dismisses the splash when loading completes
setupSplashIntegration();

// ---------------------------------------------------------------------------
// 2. Start pi (forwards CLI arguments)
// ---------------------------------------------------------------------------
// main() receives process.argv.slice(2) just like the original cli.js entry.
// At this point, DefaultResourceLoader.prototype.reload is already patched,
// so when createAgentSessionServices() creates a DefaultResourceLoader and
// calls reload(), the patched version runs.
main(process.argv.slice(2));
