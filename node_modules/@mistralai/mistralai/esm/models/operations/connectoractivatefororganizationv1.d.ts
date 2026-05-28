import * as z from "zod/v4";
import * as components from "../components/index.js";
export type ConnectorActivateForOrganizationV1Request = {
    connectorId: string;
    toolExecutionConfiguration?: components.ToolExecutionConfiguration | null | undefined;
};
/** @internal */
export type ConnectorActivateForOrganizationV1Request$Outbound = {
    connector_id: string;
    ToolExecutionConfiguration?: components.ToolExecutionConfiguration$Outbound | null | undefined;
};
/** @internal */
export declare const ConnectorActivateForOrganizationV1Request$outboundSchema: z.ZodType<ConnectorActivateForOrganizationV1Request$Outbound, ConnectorActivateForOrganizationV1Request>;
export declare function connectorActivateForOrganizationV1RequestToJSON(connectorActivateForOrganizationV1Request: ConnectorActivateForOrganizationV1Request): string;
//# sourceMappingURL=connectoractivatefororganizationv1.d.ts.map