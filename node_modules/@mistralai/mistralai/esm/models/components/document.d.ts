import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ProcessStatus } from "./processstatus.js";
export type Document = {
    id: string;
    libraryId: string;
    /**
     * @deprecated field: This will be removed in a future release, please migrate away from it as soon as possible.
     */
    hash: string | null;
    mimeType: string | null;
    extension: string | null;
    size: number | null;
    name: string;
    summary?: string | null | undefined;
    createdAt: Date;
    lastProcessedAt?: Date | null | undefined;
    numberOfPages?: number | null | undefined;
    processStatus: ProcessStatus;
    uploadedById: string | null;
    uploadedByType: string;
    /**
     * @deprecated field: This will be removed in a future release, please migrate away from it as soon as possible.
     */
    tokensProcessingMainContent?: number | null | undefined;
    /**
     * @deprecated field: This will be removed in a future release, please migrate away from it as soon as possible.
     */
    tokensProcessingSummary?: number | null | undefined;
    url?: string | null | undefined;
    attributes?: {
        [k: string]: any;
    } | null | undefined;
    /**
     * If set, the document will be automatically deleted after this date.
     */
    expiresAt?: Date | null | undefined;
    /**
     * @deprecated field: This will be removed in a future release, please migrate away from it as soon as possible.
     */
    processingStatus: string;
    tokensProcessingTotal: number;
};
/** @internal */
export declare const Document$inboundSchema: z.ZodType<Document, unknown>;
export declare function documentFromJSON(jsonString: string): SafeParseResult<Document, SDKValidationError>;
//# sourceMappingURL=document.d.ts.map