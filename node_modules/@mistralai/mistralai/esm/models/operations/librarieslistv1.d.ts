import * as z from "zod/v4";
export type LibrariesListV1Request = {
    pageSize?: number | undefined;
    page?: number | undefined;
    /**
     * Case-insensitive search on the library name.
     */
    search?: string | null | undefined;
    /**
     * Deprecated: this parameter will be removed in a future version.
     *
     * @deprecated field: This will be removed in a future release, please migrate away from it as soon as possible.
     */
    filterOwnedByMe?: boolean | null | undefined;
};
/** @internal */
export type LibrariesListV1Request$Outbound = {
    page_size: number;
    page: number;
    search?: string | null | undefined;
    filter_owned_by_me?: boolean | null | undefined;
};
/** @internal */
export declare const LibrariesListV1Request$outboundSchema: z.ZodType<LibrariesListV1Request$Outbound, LibrariesListV1Request>;
export declare function librariesListV1RequestToJSON(librariesListV1Request: LibrariesListV1Request): string;
//# sourceMappingURL=librarieslistv1.d.ts.map