import * as z from "zod/v4";
export type ConnectorDeactivateForWorkspaceV1Request = {
    connectorId: string;
};
/** @internal */
export type ConnectorDeactivateForWorkspaceV1Request$Outbound = {
    connector_id: string;
};
/** @internal */
export declare const ConnectorDeactivateForWorkspaceV1Request$outboundSchema: z.ZodType<ConnectorDeactivateForWorkspaceV1Request$Outbound, ConnectorDeactivateForWorkspaceV1Request>;
export declare function connectorDeactivateForWorkspaceV1RequestToJSON(connectorDeactivateForWorkspaceV1Request: ConnectorDeactivateForWorkspaceV1Request): string;
//# sourceMappingURL=connectordeactivateforworkspacev1.d.ts.map