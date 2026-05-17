/**
 * context-info — shim file for backward compatibility
 *
 * Re-exports default export from modular directory structure.
 * Kept for backward compatibility with extension resolution paths
 * that reference `.pi/extensions/context-info.ts` explicitly.
 */

export { default } from "./context-info/index.js";
