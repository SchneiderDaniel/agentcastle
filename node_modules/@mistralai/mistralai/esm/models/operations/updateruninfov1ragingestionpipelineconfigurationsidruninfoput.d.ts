import * as z from "zod/v4";
import * as components from "../components/index.js";
export type UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest = {
    id: string;
    updateRunInfo: components.UpdateRunInfo;
};
/** @internal */
export type UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest$Outbound = {
    id: string;
    UpdateRunInfo: components.UpdateRunInfo$Outbound;
};
/** @internal */
export declare const UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest$outboundSchema: z.ZodType<UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest$Outbound, UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest>;
export declare function updateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequestToJSON(updateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest: UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest): string;
//# sourceMappingURL=updateruninfov1ragingestionpipelineconfigurationsidruninfoput.d.ts.map