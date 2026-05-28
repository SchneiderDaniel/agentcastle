import * as z from "zod/v4";
export type CreateIngestionPipelineConfigurationRequest = {
    name: string;
    pipelineComposition?: {
        [k: string]: string;
    } | null | undefined;
};
/** @internal */
export type CreateIngestionPipelineConfigurationRequest$Outbound = {
    name: string;
    pipeline_composition?: {
        [k: string]: string;
    } | null | undefined;
};
/** @internal */
export declare const CreateIngestionPipelineConfigurationRequest$outboundSchema: z.ZodType<CreateIngestionPipelineConfigurationRequest$Outbound, CreateIngestionPipelineConfigurationRequest>;
export declare function createIngestionPipelineConfigurationRequestToJSON(createIngestionPipelineConfigurationRequest: CreateIngestionPipelineConfigurationRequest): string;
//# sourceMappingURL=createingestionpipelineconfigurationrequest.d.ts.map