import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type JobMetadata = {
    /**
     * The approximated time (in seconds) for the fine-tuning process to complete.
     */
    expectedDurationSeconds?: number | null | undefined;
    /**
     * The cost of the fine-tuning job.
     */
    cost?: number | null | undefined;
    /**
     * The currency used for the fine-tuning job cost.
     */
    costCurrency?: string | null | undefined;
    /**
     * The number of tokens consumed by one training step.
     */
    trainTokensPerStep?: number | null | undefined;
    /**
     * The total number of tokens used during the fine-tuning process.
     */
    trainTokens?: number | null | undefined;
    /**
     * The total number of tokens in the training dataset.
     */
    dataTokens?: number | null | undefined;
    estimatedStartTime?: number | null | undefined;
};
/** @internal */
export declare const JobMetadata$inboundSchema: z.ZodType<JobMetadata, unknown>;
export declare function jobMetadataFromJSON(jsonString: string): SafeParseResult<JobMetadata, SDKValidationError>;
//# sourceMappingURL=jobmetadata.d.ts.map