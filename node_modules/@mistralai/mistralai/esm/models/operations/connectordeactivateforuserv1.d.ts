import * as z from "zod/v4";
export type ConnectorDeactivateForUserV1Request = {
    connectorId: string;
};
/** @internal */
export type ConnectorDeactivateForUserV1Request$Outbound = {
    connector_id: string;
};
/** @internal */
export declare const ConnectorDeactivateForUserV1Request$outboundSchema: z.ZodType<ConnectorDeactivateForUserV1Request$Outbound, ConnectorDeactivateForUserV1Request>;
export declare function connectorDeactivateForUserV1RequestToJSON(connectorDeactivateForUserV1Request: ConnectorDeactivateForUserV1Request): string;
//# sourceMappingURL=connectordeactivateforuserv1.d.ts.map