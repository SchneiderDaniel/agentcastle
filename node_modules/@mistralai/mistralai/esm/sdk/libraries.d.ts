import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import * as operations from "../models/operations/index.js";
import { Accesses } from "./accesses.js";
import { Documents } from "./documents.js";
export declare class Libraries extends ClientSDK {
    private _documents?;
    get documents(): Documents;
    private _accesses?;
    get accesses(): Accesses;
    /**
     * List all libraries you have access to.
     *
     * @remarks
     * List all libraries that you have created or have been shared with you.
     */
    list(request?: operations.LibrariesListV1Request | undefined, options?: RequestOptions): Promise<components.ListLibrariesResponse>;
    /**
     * Create a new Library.
     *
     * @remarks
     * Create a new Library, you will be marked as the owner and only you will have the possibility to share it with others. When first created this will only be accessible by you.
     */
    create(request: components.CreateLibraryRequest, options?: RequestOptions): Promise<components.Library>;
    /**
     * Detailed information about a specific Library.
     *
     * @remarks
     * Given a library id, details information about that Library.
     */
    get(request: operations.LibrariesGetV1Request, options?: RequestOptions): Promise<components.Library>;
    /**
     * Delete a library and all of it's document.
     *
     * @remarks
     * Given a library id, deletes it together with all documents that have been uploaded to that library. Warning: the response will change from 200 (returning the deleted library) to 204 No Content in a future version.
     */
    delete(request: operations.LibrariesDeleteV1Request, options?: RequestOptions): Promise<components.Library>;
    /**
     * Update a library.
     *
     * @remarks
     * Given a library id, you can update the name and description.
     */
    update(request: operations.LibrariesPatchV1Request, options?: RequestOptions): Promise<components.Library>;
    /**
     * Update a library.
     *
     * @remarks
     * Given a library id, you can update the name and description.
     *
     * @deprecated method: Use the PATCH method instead. This PUT endpoint will be removed in a future version..
     */
    librariesUpdateV1(request: operations.LibrariesUpdateV1Request, options?: RequestOptions): Promise<components.Library>;
}
//# sourceMappingURL=libraries.d.ts.map