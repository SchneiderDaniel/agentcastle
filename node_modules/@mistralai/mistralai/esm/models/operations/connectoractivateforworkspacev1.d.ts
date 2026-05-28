import * as z from "zod/v4";
import * as components from "../components/index.js";
export type ConnectorActivateForWorkspaceV1Request = {
    connectorId: string;
    toolExecutionConfiguration?: components.ToolExecutionConfiguration | null | undefined;
};
/** @internal */
export type ConnectorActivateForWorkspaceV1Request$Outbound = {
    connector_id: string;
    ToolExecutionConfiguration?: components.ToolExecutionConfiguration$Outbound | null | undefined;
};
/** @internal */
export declare const ConnectorActivateForWorkspaceV1Request$outboundSchema: z.ZodType<ConnectorActivateForWorkspaceV1Request$Outbound, ConnectorActivateForWorkspaceV1Request>;
export declare function connectorActivateForWorkspaceV1RequestToJSON(connectorActivateForWorkspaceV1Request: ConnectorActivateForWorkspaceV1Request): string;
//# sourceMappingURL=connectoractivateforworkspacev1.d.ts.map