import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import * as operations from "../models/operations/index.js";
export declare class Accesses extends ClientSDK {
    /**
     * List all of the access to this library.
     *
     * @remarks
     * Given a library, list all of the Entity that have access and to what level.
     */
    list(request: operations.LibrariesShareListV1Request, options?: RequestOptions): Promise<components.ListSharingResponse>;
    /**
     * Create or update an access level.
     *
     * @remarks
     * Given a library id, you can create or update the access level of an entity. You have to be owner of the library to share a library. An owner cannot change their own role. A library cannot be shared outside of the organization.
     */
    updateOrCreate(request: operations.LibrariesShareCreateV1Request, options?: RequestOptions): Promise<components.Sharing>;
    /**
     * Delete an access level.
     *
     * @remarks
     * Given a library id, you can delete the access level of an entity. An owner cannot delete their own access. You have to be the owner of the library to delete an access other than yours. Warning: the response will change from 200 (returning the deleted sharing) to 204 No Content in a future version.
     */
    delete(request: operations.LibrariesShareDeleteV1Request, options?: RequestOptions): Promise<components.Sharing>;
}
//# sourceMappingURL=accesses.d.ts.map