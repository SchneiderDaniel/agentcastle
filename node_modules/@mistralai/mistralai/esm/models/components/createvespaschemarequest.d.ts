import * as z from "zod/v4";
export type CreateVespaSchemaRequest = {
    name: string;
    documentCount?: number | null | undefined;
};
/** @internal */
export type CreateVespaSchemaRequest$Outbound = {
    name: string;
    document_count?: number | null | undefined;
};
/** @internal */
export declare const CreateVespaSchemaRequest$outboundSchema: z.ZodType<CreateVespaSchemaRequest$Outbound, CreateVespaSchemaRequest>;
export declare function createVespaSchemaRequestToJSON(createVespaSchemaRequest: CreateVespaSchemaRequest): string;
//# sourceMappingURL=createvespaschemarequest.d.ts.map