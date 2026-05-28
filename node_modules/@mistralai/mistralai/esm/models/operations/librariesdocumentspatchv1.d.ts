import * as z from "zod/v4";
import * as components from "../components/index.js";
export type LibrariesDocumentsPatchV1Request = {
    libraryId: string;
    documentId: string;
    updateDocumentRequest: components.UpdateDocumentRequest;
};
/** @internal */
export type LibrariesDocumentsPatchV1Request$Outbound = {
    library_id: string;
    document_id: string;
    UpdateDocumentRequest: components.UpdateDocumentRequest$Outbound;
};
/** @internal */
export declare const LibrariesDocumentsPatchV1Request$outboundSchema: z.ZodType<LibrariesDocumentsPatchV1Request$Outbound, LibrariesDocumentsPatchV1Request>;
export declare function librariesDocumentsPatchV1RequestToJSON(librariesDocumentsPatchV1Request: LibrariesDocumentsPatchV1Request): string;
//# sourceMappingURL=librariesdocumentspatchv1.d.ts.map