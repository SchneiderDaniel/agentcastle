import * as z from "zod/v4";
import { ClosedEnum } from "../../types/enums.js";
import { CreateVespaSearchIndexInfoRequest, CreateVespaSearchIndexInfoRequest$Outbound } from "./createvespasearchindexinforequest.js";
export declare const CreateSearchIndexInfoRequestStatus: {
    readonly Online: "online";
    readonly Offline: "offline";
};
export type CreateSearchIndexInfoRequestStatus = ClosedEnum<typeof CreateSearchIndexInfoRequestStatus>;
export type CreateSearchIndexInfoRequestIndex = CreateVespaSearchIndexInfoRequest;
export type CreateSearchIndexInfoRequest = {
    name: string;
    documentCount?: number | null | undefined;
    status?: CreateSearchIndexInfoRequestStatus | undefined;
    index: CreateVespaSearchIndexInfoRequest;
};
/** @internal */
export declare const CreateSearchIndexInfoRequestStatus$outboundSchema: z.ZodEnum<typeof CreateSearchIndexInfoRequestStatus>;
/** @internal */
export type CreateSearchIndexInfoRequestIndex$Outbound = CreateVespaSearchIndexInfoRequest$Outbound;
/** @internal */
export declare const CreateSearchIndexInfoRequestIndex$outboundSchema: z.ZodType<CreateSearchIndexInfoRequestIndex$Outbound, CreateSearchIndexInfoRequestIndex>;
export declare function createSearchIndexInfoRequestIndexToJSON(createSearchIndexInfoRequestIndex: CreateSearchIndexInfoRequestIndex): string;
/** @internal */
export type CreateSearchIndexInfoRequest$Outbound = {
    name: string;
    document_count?: number | null | undefined;
    status: string;
    index: CreateVespaSearchIndexInfoRequest$Outbound;
};
/** @internal */
export declare const CreateSearchIndexInfoRequest$outboundSchema: z.ZodType<CreateSearchIndexInfoRequest$Outbound, CreateSearchIndexInfoRequest>;
export declare function createSearchIndexInfoRequestToJSON(createSearchIndexInfoRequest: CreateSearchIndexInfoRequest): string;
//# sourceMappingURL=createsearchindexinforequest.d.ts.map