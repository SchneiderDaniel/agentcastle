import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { AuthenticationConfiguration } from "./authenticationconfiguration.js";
import { OutboundAuthenticationType } from "./outboundauthenticationtype.js";
export type CredentialsResponse = {
    credentials: Array<AuthenticationConfiguration>;
    connectorPresetCredentialsForAuth?: Array<OutboundAuthenticationType> | undefined;
};
/** @internal */
export declare const CredentialsResponse$inboundSchema: z.ZodType<CredentialsResponse, unknown>;
export declare function credentialsResponseFromJSON(jsonString: string): SafeParseResult<CredentialsResponse, SDKValidationError>;
//# sourceMappingURL=credentialsresponse.d.ts.map