import * as z from "zod/v4";
export type ConnectorDeactivateForOrganizationV1Request = {
    connectorId: string;
};
/** @internal */
export type ConnectorDeactivateForOrganizationV1Request$Outbound = {
    connector_id: string;
};
/** @internal */
export declare const ConnectorDeactivateForOrganizationV1Request$outboundSchema: z.ZodType<ConnectorDeactivateForOrganizationV1Request$Outbound, ConnectorDeactivateForOrganizationV1Request>;
export declare function connectorDeactivateForOrganizationV1RequestToJSON(connectorDeactivateForOrganizationV1Request: ConnectorDeactivateForOrganizationV1Request): string;
//# sourceMappingURL=connectordeactivatefororganizationv1.d.ts.map