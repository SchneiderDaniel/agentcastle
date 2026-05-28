import * as z from "zod/v4";
import * as components from "../components/index.js";
export type ConnectorActivateForUserV1Request = {
    connectorId: string;
    toolExecutionConfiguration?: components.ToolExecutionConfiguration | null | undefined;
};
/** @internal */
export type ConnectorActivateForUserV1Request$Outbound = {
    connector_id: string;
    ToolExecutionConfiguration?: components.ToolExecutionConfiguration$Outbound | null | undefined;
};
/** @internal */
export declare const ConnectorActivateForUserV1Request$outboundSchema: z.ZodType<ConnectorActivateForUserV1Request$Outbound, ConnectorActivateForUserV1Request>;
export declare function connectorActivateForUserV1RequestToJSON(connectorActivateForUserV1Request: ConnectorActivateForUserV1Request): string;
//# sourceMappingURL=connectoractivateforuserv1.d.ts.map