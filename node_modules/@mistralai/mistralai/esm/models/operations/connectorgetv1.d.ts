import * as z from "zod/v4";
export type ConnectorGetV1Request = {
    /**
     * Fetch the user-level data associated with the connector (e.g. connection credentials).
     */
    fetchUserData?: boolean | undefined;
    /**
     * Fetch the customer data associated with the connector (e.g. customer secrets / config).
     */
    fetchCustomerData?: boolean | undefined;
    connectorIdOrName: string;
};
/** @internal */
export type ConnectorGetV1Request$Outbound = {
    fetch_user_data: boolean;
    fetch_customer_data: boolean;
    connector_id_or_name: string;
};
/** @internal */
export declare const ConnectorGetV1Request$outboundSchema: z.ZodType<ConnectorGetV1Request$Outbound, ConnectorGetV1Request>;
export declare function connectorGetV1RequestToJSON(connectorGetV1Request: ConnectorGetV1Request): string;
//# sourceMappingURL=connectorgetv1.d.ts.map