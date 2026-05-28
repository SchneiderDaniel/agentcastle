import * as z from "zod/v4";
export type Attributes = boolean | string | number | number | Date | Array<string> | Array<number> | Array<number> | Array<boolean>;
export type UpdateDocumentRequest = {
    name?: string | undefined;
    attributes?: {
        [k: string]: boolean | string | number | number | Date | Array<string> | Array<number> | Array<number> | Array<boolean>;
    } | null | undefined;
    /**
     * If set, the document will be automatically deleted after this date.
     */
    expiresAt?: Date | null | undefined;
};
/** @internal */
export type Attributes$Outbound = boolean | string | number | number | string | Array<string> | Array<number> | Array<number> | Array<boolean>;
/** @internal */
export declare const Attributes$outboundSchema: z.ZodType<Attributes$Outbound, Attributes>;
export declare function attributesToJSON(attributes: Attributes): string;
/** @internal */
export type UpdateDocumentRequest$Outbound = {
    name?: string | undefined;
    attributes?: {
        [k: string]: boolean | string | number | number | string | Array<string> | Array<number> | Array<number> | Array<boolean>;
    } | null | undefined;
    expires_at?: string | null | undefined;
};
/** @internal */
export declare const UpdateDocumentRequest$outboundSchema: z.ZodType<UpdateDocumentRequest$Outbound, UpdateDocumentRequest>;
export declare function updateDocumentRequestToJSON(updateDocumentRequest: UpdateDocumentRequest): string;
//# sourceMappingURL=updatedocumentrequest.d.ts.map