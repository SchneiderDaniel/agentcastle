import * as z from "zod/v4";
import * as components from "../components/index.js";
export type LibrariesPatchV1Request = {
    libraryId: string;
    updateLibraryRequest: components.UpdateLibraryRequest;
};
/** @internal */
export type LibrariesPatchV1Request$Outbound = {
    library_id: string;
    UpdateLibraryRequest: components.UpdateLibraryRequest$Outbound;
};
/** @internal */
export declare const LibrariesPatchV1Request$outboundSchema: z.ZodType<LibrariesPatchV1Request$Outbound, LibrariesPatchV1Request>;
export declare function librariesPatchV1RequestToJSON(librariesPatchV1Request: LibrariesPatchV1Request): string;
//# sourceMappingURL=librariespatchv1.d.ts.map