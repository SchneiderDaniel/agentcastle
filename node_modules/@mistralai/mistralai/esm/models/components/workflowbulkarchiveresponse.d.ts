import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Workflow } from "./workflow.js";
import { WorkflowBulkError } from "./workflowbulkerror.js";
export type WorkflowBulkArchiveResponse = {
    /**
     * Workflows that were successfully archived or were already archived
     */
    archived: Array<Workflow>;
    /**
     * Workflows that could not be archived and the corresponding error messages
     */
    errored?: Array<WorkflowBulkError> | undefined;
};
/** @internal */
export declare const WorkflowBulkArchiveResponse$inboundSchema: z.ZodType<WorkflowBulkArchiveResponse, unknown>;
export declare function workflowBulkArchiveResponseFromJSON(jsonString: string): SafeParseResult<WorkflowBulkArchiveResponse, SDKValidationError>;
//# sourceMappingURL=workflowbulkarchiveresponse.d.ts.map