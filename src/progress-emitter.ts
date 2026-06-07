/**
 * ProgressEmitter — Emits extension loading progress events via eventBus.
 *
 * This module wraps the extension loading loop to emit progress events
 * as each extension factory resolves or rejects. It bridges between the
 * pi-coding-agent's extension loader and the SplashComponent.
 *
 * Usage:
 *   const emitter = new ProgressEmitter(extensions, eventBus);
 *   emitter.onProgress((event) => { ... });
 *   for (const ext of extensions) {
 *     await loadExtension(ext.path, cwd, eventBus, runtime);
 *     emitter.emitProgress(ext.name, "done");
 *   }
 */

import type {
	ExtensionLoadStatus,
	ExtensionProgressEntry,
	ExtensionLoadingProgressEvent,
	LoadingProgress,
} from "./extension-progress-types.js";
import { createLoadingProgress, applyProgressDelta } from "./extension-progress-types.js";

/** An extension entry to track. */
export interface ExtEntry {
	name: string;
	path: string;
}

/** Listener type for progress events. */
export type ProgressEventListener = (event: ExtensionLoadingProgressEvent) => void;

/**
 * ProgressEmitter tracks extension loading state and emits progress events.
 *
 * Create one before loading extensions, call emitProgress() after each
 * extension factory resolves, and the emitter will notify all listeners.
 */
export class ProgressEmitter {
	private _entries: ExtEntry[];
	private _state: LoadingProgress;
	private _listeners: Set<ProgressEventListener> = new Set();

	constructor(extensions: ExtEntry[]) {
		this._entries = extensions;
		const names = extensions.map((e) => e.name);
		this._state = createLoadingProgress(names);
	}

	/** Get the current loading state. */
	get state(): LoadingProgress {
		return this._state;
	}

	/** Get the extension entries being tracked. */
	get entries(): ExtEntry[] {
		return this._entries;
	}

	/**
	 * Register a progress event listener.
	 * Returns an unsubscribe function.
	 */
	onProgress(listener: ProgressEventListener): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/**
	 * Emit progress for one extension after its factory completes.
	 *
	 * @param extensionName - Name of the extension that resolved.
	 * @param status - Final status ("done" or "failed").
	 * @param error - Optional error message if status is "failed".
	 */
	emitProgress(extensionName: string, status: ExtensionLoadStatus, error?: string): void {
		// Update internal state
		this._state = applyProgressDelta(this._state, {
			name: extensionName,
			status,
			error: error ?? this._getEntryError(extensionName),
		});

		// Build the event
		const event: ExtensionLoadingProgressEvent = {
			type: "extension_loading_progress",
			total: this._state.total,
			completed: this._state.completed,
			failed: this._state.failed,
			pending: this._state.pending,
			entries: [...this._state.entries],
		};

		// Notify all listeners
		for (const listener of this._listeners) {
			listener(event);
		}
	}

	/** Check if all extensions have completed (done + failed === total). */
	get isComplete(): boolean {
		return this._state.completed + this._state.failed === this._state.total;
	}

	/** Get the fraction of completed+failed over total (0-1). */
	get fraction(): number {
		if (this._state.total === 0) return 1;
		return (this._state.completed + this._state.failed) / this._state.total;
	}

	/** Get the error for a given extension entry (from initial state). */
	private _getEntryError(name: string): string | undefined {
		const entry = this._state.entries.find((e) => e.name === name);
		return entry?.error;
	}
}
