import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Workflow } from "./workflow.js";
import { WorkflowBulkError } from "./workflowbulkerror.js";
export type WorkflowBulkUnarchiveResponse = {
    /**
     * Workflows that were successfully unarchived or were already unarchived
     */
    unarchived: Array<Workflow>;
    /**
     * Workflows that could not be unarchived and the corresponding error messages
     */
    errored?: Array<WorkflowBulkError> | undefined;
};
/** @internal */
export declare const WorkflowBulkUnarchiveResponse$inboundSchema: z.ZodType<WorkflowBulkUnarchiveResponse, unknown>;
export declare function workflowBulkUnarchiveResponseFromJSON(jsonString: string): SafeParseResult<WorkflowBulkUnarchiveResponse, SDKValidationError>;
//# sourceMappingURL=workflowbulkunarchiveresponse.d.ts.map