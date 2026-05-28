import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type IngestionPipelineConfiguration = {
    id: string;
    authorId: string;
    name: string;
    createdAt: Date;
    modifiedAt: Date;
    lastRunTime: Date | null;
    lastRunChunksCount: number;
    totalChunksCount: number;
    pipelineComposition: {
        [k: string]: string;
    } | null;
};
/** @internal */
export declare const IngestionPipelineConfiguration$inboundSchema: z.ZodType<IngestionPipelineConfiguration, unknown>;
export declare function ingestionPipelineConfigurationFromJSON(jsonString: string): SafeParseResult<IngestionPipelineConfiguration, SDKValidationError>;
//# sourceMappingURL=ingestionpipelineconfiguration.d.ts.map