import { MistralCore } from "../core.js";
import { RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import { ConnectionError, InvalidRequestError, RequestAbortedError, RequestTimeoutError, UnexpectedClientError } from "../models/errors/httpclienterrors.js";
import * as errors from "../models/errors/index.js";
import { MistralError } from "../models/errors/mistralerror.js";
import { ResponseValidationError } from "../models/errors/responsevalidationerror.js";
import { SDKValidationError } from "../models/errors/sdkvalidationerror.js";
import * as operations from "../models/operations/index.js";
import { APIPromise } from "../types/async.js";
import { Result } from "../types/fp.js";
/**
 * Update a library.
 *
 * @remarks
 * Given a library id, you can update the name and description.
 *
 * @deprecated method: Use the PATCH method instead. This PUT endpoint will be removed in a future version..
 */
export declare function betaLibrariesLibrariesUpdateV1(client: MistralCore, request: operations.LibrariesUpdateV1Request, options?: RequestOptions): APIPromise<Result<components.Library, errors.HTTPValidationError | MistralError | ResponseValidationError | ConnectionError | RequestAbortedError | RequestTimeoutError | InvalidRequestError | UnexpectedClientError | SDKValidationError>>;
//# sourceMappingURL=betaLibrariesLibrariesUpdateV1.d.ts.map