import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { VespaSearchIndexInfoResponse } from "./vespasearchindexinforesponse.js";
export declare const SearchIndexResponseStatus: {
    readonly Online: "online";
    readonly Offline: "offline";
};
export type SearchIndexResponseStatus = OpenEnum<typeof SearchIndexResponseStatus>;
export type SearchIndexResponseIndex = VespaSearchIndexInfoResponse;
export type SearchIndexResponse = {
    id: string;
    name: string;
    creatorId: string;
    documentCount: number;
    status: SearchIndexResponseStatus;
    createdAt: Date;
    modifiedAt: Date;
    index: VespaSearchIndexInfoResponse;
};
/** @internal */
export declare const SearchIndexResponseStatus$inboundSchema: z.ZodType<SearchIndexResponseStatus, unknown>;
/** @internal */
export declare const SearchIndexResponseIndex$inboundSchema: z.ZodType<SearchIndexResponseIndex, unknown>;
export declare function searchIndexResponseIndexFromJSON(jsonString: string): SafeParseResult<SearchIndexResponseIndex, SDKValidationError>;
/** @internal */
export declare const SearchIndexResponse$inboundSchema: z.ZodType<SearchIndexResponse, unknown>;
export declare function searchIndexResponseFromJSON(jsonString: string): SafeParseResult<SearchIndexResponse, SDKValidationError>;
//# sourceMappingURL=searchindexresponse.d.ts.map