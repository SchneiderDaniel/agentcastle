import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Checkpoint } from "./checkpoint.js";
import { CompletionTrainingParameters } from "./completiontrainingparameters.js";
import { Event } from "./event.js";
import { GithubRepository } from "./githubrepository.js";
import { JobMetadata } from "./jobmetadata.js";
import { WandbIntegrationResult } from "./wandbintegrationresult.js";
/**
 * The current status of the fine-tuning job.
 */
export declare const CompletionFineTuningJobDetailsStatus: {
    readonly Queued: "QUEUED";
    readonly Started: "STARTED";
    readonly Validating: "VALIDATING";
    readonly Validated: "VALIDATED";
    readonly Running: "RUNNING";
    readonly FailedValidation: "FAILED_VALIDATION";
    readonly Failed: "FAILED";
    readonly Success: "SUCCESS";
    readonly Cancelled: "CANCELLED";
    readonly CancellationRequested: "CANCELLATION_REQUESTED";
};
/**
 * The current status of the fine-tuning job.
 */
export type CompletionFineTuningJobDetailsStatus = OpenEnum<typeof CompletionFineTuningJobDetailsStatus>;
export type CompletionFineTuningJobDetailsIntegration = WandbIntegrationResult;
export type CompletionFineTuningJobDetailsRepository = GithubRepository;
export type CompletionFineTuningJobDetails = {
    /**
     * The ID of the job.
     */
    id: string;
    autoStart: boolean;
    model: string;
    /**
     * The current status of the fine-tuning job.
     */
    status: CompletionFineTuningJobDetailsStatus;
    /**
     * The UNIX timestamp (in seconds) for when the fine-tuning job was created.
     */
    createdAt: number;
    /**
     * The UNIX timestamp (in seconds) for when the fine-tuning job was last modified.
     */
    modifiedAt: number;
    /**
     * A list containing the IDs of uploaded files that contain training data.
     */
    trainingFiles: Array<string>;
    /**
     * A list containing the IDs of uploaded files that contain validation data.
     */
    validationFiles?: Array<string> | null | undefined;
    /**
     * The object type of the fine-tuning job.
     */
    object: "job";
    /**
     * The name of the fine-tuned model that is being created. The value will be `null` if the fine-tuning job is still running.
     */
    fineTunedModel?: string | null | undefined;
    /**
     * Optional user-provided string inserted into the fine-tuned model name to help identify it. For example, a suffix of `"my-great-model"` produces a name like `ft:open-mistral-7b:abcd1234:20260101:my-great-model:efgh5678`.
     */
    suffix?: string | null | undefined;
    /**
     * A list of integrations enabled for your fine-tuning job.
     */
    integrations?: Array<WandbIntegrationResult> | null | undefined;
    /**
     * Total number of tokens trained.
     */
    trainedTokens?: number | null | undefined;
    metadata?: JobMetadata | null | undefined;
    /**
     * The type of job (`FT` for fine-tuning).
     */
    jobType: "completion";
    hyperparameters: CompletionTrainingParameters;
    repositories?: Array<GithubRepository> | undefined;
    /**
     * Event items are created every time the status of a fine-tuning job changes. The timestamped list of all events is accessible here.
     */
    events?: Array<Event> | undefined;
    checkpoints?: Array<Checkpoint> | undefined;
};
/** @internal */
export declare const CompletionFineTuningJobDetailsStatus$inboundSchema: z.ZodType<CompletionFineTuningJobDetailsStatus, unknown>;
/** @internal */
export declare const CompletionFineTuningJobDetailsIntegration$inboundSchema: z.ZodType<CompletionFineTuningJobDetailsIntegration, unknown>;
export declare function completionFineTuningJobDetailsIntegrationFromJSON(jsonString: string): SafeParseResult<CompletionFineTuningJobDetailsIntegration, SDKValidationError>;
/** @internal */
export declare const CompletionFineTuningJobDetailsRepository$inboundSchema: z.ZodType<CompletionFineTuningJobDetailsRepository, unknown>;
export declare function completionFineTuningJobDetailsRepositoryFromJSON(jsonString: string): SafeParseResult<CompletionFineTuningJobDetailsRepository, SDKValidationError>;
/** @internal */
export declare const CompletionFineTuningJobDetails$inboundSchema: z.ZodType<CompletionFineTuningJobDetails, unknown>;
export declare function completionFineTuningJobDetailsFromJSON(jsonString: string): SafeParseResult<CompletionFineTuningJobDetails, SDKValidationError>;
//# sourceMappingURL=completionfinetuningjobdetails.d.ts.map