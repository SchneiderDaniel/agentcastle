#!/usr/bin/env node
/**
 * pi startup wrapper — AgentCastle entry point.
 *
 * Shows a loading status line on stderr during extension startup.
 *
 * Usage:
 *   node --experimental-strip-types src/start-pi.ts [args...]
 *
 * Or via npm script:
 *   npm run pi -- [args...]
 */

import { setupLoadingIndicator } from "./loading-indicator.ts";
import { main } from "@earendil-works/pi-coding-agent";

// Patch DefaultResourceLoader before main() creates any instance
setupLoadingIndicator();

// Start pi — forwards CLI arguments
main(process.argv.slice(2));
