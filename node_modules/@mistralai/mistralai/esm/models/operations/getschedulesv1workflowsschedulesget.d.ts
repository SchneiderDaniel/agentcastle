import * as z from "zod/v4";
import { ClosedEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import * as components from "../components/index.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Filter by schedule status: 'active' or 'paused'
 */
export declare const GetSchedulesV1WorkflowsSchedulesGetStatus: {
    readonly Active: "active";
    readonly Paused: "paused";
};
/**
 * Filter by schedule status: 'active' or 'paused'
 */
export type GetSchedulesV1WorkflowsSchedulesGetStatus = ClosedEnum<typeof GetSchedulesV1WorkflowsSchedulesGetStatus>;
export type GetSchedulesV1WorkflowsSchedulesGetRequest = {
    /**
     * Filter by workflow name
     */
    workflowName?: string | null | undefined;
    /**
     * Filter by user ID. Pass 'current' to resolve to the authenticated user's ID.
     */
    userId?: string | null | undefined;
    /**
     * Filter by schedule status: 'active' or 'paused'
     */
    status?: GetSchedulesV1WorkflowsSchedulesGetStatus | null | undefined;
    /**
     * Number of items per page. Omitting this parameter fetches all results at once (deprecated — pass page_size to use pagination).
     */
    pageSize?: number | null | undefined;
    /**
     * Token for the next page of results
     */
    nextPageToken?: string | null | undefined;
};
export type GetSchedulesV1WorkflowsSchedulesGetResponse = {
    result: components.WorkflowScheduleListResponse;
};
/** @internal */
export declare const GetSchedulesV1WorkflowsSchedulesGetStatus$outboundSchema: z.ZodEnum<typeof GetSchedulesV1WorkflowsSchedulesGetStatus>;
/** @internal */
export type GetSchedulesV1WorkflowsSchedulesGetRequest$Outbound = {
    workflow_name?: string | null | undefined;
    user_id?: string | null | undefined;
    status?: string | null | undefined;
    page_size?: number | null | undefined;
    next_page_token?: string | null | undefined;
};
/** @internal */
export declare const GetSchedulesV1WorkflowsSchedulesGetRequest$outboundSchema: z.ZodType<GetSchedulesV1WorkflowsSchedulesGetRequest$Outbound, GetSchedulesV1WorkflowsSchedulesGetRequest>;
export declare function getSchedulesV1WorkflowsSchedulesGetRequestToJSON(getSchedulesV1WorkflowsSchedulesGetRequest: GetSchedulesV1WorkflowsSchedulesGetRequest): string;
/** @internal */
export declare const GetSchedulesV1WorkflowsSchedulesGetResponse$inboundSchema: z.ZodType<GetSchedulesV1WorkflowsSchedulesGetResponse, unknown>;
export declare function getSchedulesV1WorkflowsSchedulesGetResponseFromJSON(jsonString: string): SafeParseResult<GetSchedulesV1WorkflowsSchedulesGetResponse, SDKValidationError>;
//# sourceMappingURL=getschedulesv1workflowsschedulesget.d.ts.map