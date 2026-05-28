import * as z from "zod/v4";
import { CreateVespaSchemaRequest, CreateVespaSchemaRequest$Outbound } from "./createvespaschemarequest.js";
export type CreateVespaSearchIndexInfoRequest = {
    type: "vespa";
    k8sCluster: string;
    k8sNamespace: string;
    vespaInstanceName: string;
    schemas: Array<CreateVespaSchemaRequest>;
};
/** @internal */
export type CreateVespaSearchIndexInfoRequest$Outbound = {
    type: "vespa";
    k8s_cluster: string;
    k8s_namespace: string;
    vespa_instance_name: string;
    schemas: Array<CreateVespaSchemaRequest$Outbound>;
};
/** @internal */
export declare const CreateVespaSearchIndexInfoRequest$outboundSchema: z.ZodType<CreateVespaSearchIndexInfoRequest$Outbound, CreateVespaSearchIndexInfoRequest>;
export declare function createVespaSearchIndexInfoRequestToJSON(createVespaSearchIndexInfoRequest: CreateVespaSearchIndexInfoRequest): string;
//# sourceMappingURL=createvespasearchindexinforequest.d.ts.map