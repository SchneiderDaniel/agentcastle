import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { JSONPayloadResponse } from "./jsonpayloadresponse.js";
/**
 * Attributes for workflow execution completed events.
 */
export type WorkflowExecutionCompletedAttributesResponse = {
    /**
     * Unique identifier for the task within the workflow execution.
     */
    taskId: string;
    /**
     * A payload containing arbitrary JSON data.
     *
     * @remarks
     *
     * Used for complete state snapshots or final results.
     * When encrypted, the value field contains base64-encoded encrypted data
     * and encoding_options indicates the type of encryption applied.
     */
    result: JSONPayloadResponse;
};
/** @internal */
export declare const WorkflowExecutionCompletedAttributesResponse$inboundSchema: z.ZodType<WorkflowExecutionCompletedAttributesResponse, unknown>;
export declare function workflowExecutionCompletedAttributesResponseFromJSON(jsonString: string): SafeParseResult<WorkflowExecutionCompletedAttributesResponse, SDKValidationError>;
//# sourceMappingURL=workflowexecutioncompletedattributesresponse.d.ts.map