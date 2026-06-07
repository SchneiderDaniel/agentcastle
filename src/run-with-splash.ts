/**
 * run-with-splash.ts — removed unused content.
 *
 * The `runWithSplash()` function was removed — it was dead code never
 * imported from any production startup path. The integration is done
 * via `setupSplashIntegration()` in `integrate-splash.ts`.
 *
 * `clearSplash()` was moved to `integrate-splash.ts`. Import from there.
 *
 * The test file (`test/run-with-splash.test.mts`) remains with its own
 * inline replicated copy of the function for regression coverage.
 */

export {};
