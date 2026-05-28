import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Checkpoint } from "./checkpoint.js";
import { ClassifierTargetResult } from "./classifiertargetresult.js";
import { ClassifierTrainingParameters } from "./classifiertrainingparameters.js";
import { Event } from "./event.js";
import { JobMetadata } from "./jobmetadata.js";
import { WandbIntegrationResult } from "./wandbintegrationresult.js";
/**
 * The current status of the fine-tuning job.
 */
export declare const ClassifierFineTuningJobDetailsStatus: {
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
export type ClassifierFineTuningJobDetailsStatus = OpenEnum<typeof ClassifierFineTuningJobDetailsStatus>;
export type ClassifierFineTuningJobDetailsIntegration = WandbIntegrationResult;
export type ClassifierFineTuningJobDetails = {
    /**
     * The ID of the job.
     */
    id: string;
    autoStart: boolean;
    model: string;
    /**
     * The current status of the fine-tuning job.
     */
    status: ClassifierFineTuningJobDetailsStatus;
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
    jobType: "classifier";
    hyperparameters: ClassifierTrainingParameters;
    /**
     * Event items are created every time the status of a fine-tuning job changes. The timestamped list of all events is accessible here.
     */
    events?: Array<Event> | undefined;
    checkpoints?: Array<Checkpoint> | undefined;
    classifierTargets: Array<ClassifierTargetResult>;
};
/** @internal */
export declare const ClassifierFineTuningJobDetailsStatus$inboundSchema: z.ZodType<ClassifierFineTuningJobDetailsStatus, unknown>;
/** @internal */
export declare const ClassifierFineTuningJobDetailsIntegration$inboundSchema: z.ZodType<ClassifierFineTuningJobDetailsIntegration, unknown>;
export declare function classifierFineTuningJobDetailsIntegrationFromJSON(jsonString: string): SafeParseResult<ClassifierFineTuningJobDetailsIntegration, SDKValidationError>;
/** @internal */
export declare const ClassifierFineTuningJobDetails$inboundSchema: z.ZodType<ClassifierFineTuningJobDetails, unknown>;
export declare function classifierFineTuningJobDetailsFromJSON(jsonString: string): SafeParseResult<ClassifierFineTuningJobDetails, SDKValidationError>;
//# sourceMappingURL=classifierfinetuningjobdetails.d.ts.map