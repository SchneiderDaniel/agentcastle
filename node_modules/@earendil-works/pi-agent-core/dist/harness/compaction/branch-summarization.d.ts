import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.js";
import type { BranchSummaryResult, Session, SessionTreeEntry } from "../types.js";
import { BranchSummaryError, type Result } from "../types.js";
import { type FileOperations } from "./utils.js";
/** File-operation details stored on generated branch summary entries. */
export interface BranchSummaryDetails {
    /** Files read while exploring the summarized branch. */
    readFiles: string[];
    /** Files modified while exploring the summarized branch. */
    modifiedFiles: string[];
}
export type { FileOperations } from "./utils.js";
/** Prepared branch content for summarization. */
export interface BranchPreparation {
    /** Messages selected for the branch summary. */
    messages: AgentMessage[];
    /** File operations extracted from the branch. */
    fileOps: FileOperations;
    /** Estimated token count for selected messages. */
    totalTokens: number;
}
/** Entries selected for branch summarization. */
export interface CollectEntriesResult {
    /** Entries to summarize in chronological order. */
    entries: SessionTreeEntry[];
    /** Deepest common ancestor between the previous leaf and target entry. */
    commonAncestorId: string | null;
}
/** Options for generating a branch summary. */
export interface GenerateBranchSummaryOptions {
    /** Model used for summarization. */
    model: Model<any>;
    /** API key forwarded to the provider. */
    apiKey: string;
    /** Optional request headers forwarded to the provider. */
    headers?: Record<string, string>;
    /** Abort signal for the summarization request. */
    signal: AbortSignal;
    /** Optional instructions appended to or replacing the default prompt. */
    customInstructions?: string;
    /** Replace the default prompt with custom instructions instead of appending them. */
    replaceInstructions?: boolean;
    /** Tokens reserved for prompt and model output. Defaults to 16384. */
    reserveTokens?: number;
}
/** Collect entries that should be summarized before navigating to a different session tree entry. */
export declare function collectEntriesForBranchSummary(session: Session, oldLeafId: string | null, targetId: string): Promise<CollectEntriesResult>;
/** Prepare branch entries for summarization within an optional token budget. */
export declare function prepareBranchEntries(entries: SessionTreeEntry[], tokenBudget?: number): BranchPreparation;
/** Generate a summary for abandoned branch entries. */
export declare function generateBranchSummary(entries: SessionTreeEntry[], options: GenerateBranchSummaryOptions): Promise<Result<BranchSummaryResult, BranchSummaryError>>;
//# sourceMappingURL=branch-summarization.d.ts.map