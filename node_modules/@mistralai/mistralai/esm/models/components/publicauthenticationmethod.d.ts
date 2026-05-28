import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ConnectorAuthenticationHeader } from "./connectorauthenticationheader.js";
import { OutboundAuthenticationType } from "./outboundauthenticationtype.js";
/**
 * Public view of an authentication method, without secrets.
 */
export type PublicAuthenticationMethod = {
    methodType: OutboundAuthenticationType;
    headers?: Array<ConnectorAuthenticationHeader> | null | undefined;
    hasDefaultCredentials: boolean;
};
/** @internal */
export declare const PublicAuthenticationMethod$inboundSchema: z.ZodType<PublicAuthenticationMethod, unknown>;
export declare function publicAuthenticationMethodFromJSON(jsonString: string): SafeParseResult<PublicAuthenticationMethod, SDKValidationError>;
//# sourceMappingURL=publicauthenticationmethod.d.ts.map