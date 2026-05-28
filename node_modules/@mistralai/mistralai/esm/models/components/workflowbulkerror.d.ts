import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Workflow } from "./workflow.js";
export type WorkflowBulkError = {
    /**
     * The requested workflow ID
     */
    workflowId: string;
    /**
     * The workflow, if found
     */
    workflow?: Workflow | null | undefined;
    /**
     * Error message describing why the operation failed
     */
    message: string;
};
/** @internal */
export declare const WorkflowBulkError$inboundSchema: z.ZodType<WorkflowBulkError, unknown>;
export declare function workflowBulkErrorFromJSON(jsonString: string): SafeParseResult<WorkflowBulkError, SDKValidationError>;
//# sourceMappingURL=workflowbulkerror.d.ts.map