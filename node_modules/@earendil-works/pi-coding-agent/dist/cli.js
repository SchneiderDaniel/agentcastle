#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import { APP_NAME } from "./config.js";
import { main } from "./main.js";
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => { });
// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
// AbortController-based deadlines via retry.provider.timeoutMs.
// Node 26 uses an internal undici for globalThis.fetch that does not honor npm
// undici's global dispatcher, so route global fetch through npm undici as well.
const dispatcher = new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 });
setGlobalDispatcher(dispatcher);
const fetchWithDispatcher = undiciFetch;
globalThis.fetch = (input, init) => fetchWithDispatcher(input, {
    ...init,
    dispatcher,
});
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map