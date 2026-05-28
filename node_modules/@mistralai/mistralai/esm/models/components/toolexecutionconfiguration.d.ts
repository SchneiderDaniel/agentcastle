import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { LogicalExpression, LogicalExpression$Outbound } from "./logicalexpression.js";
import { ToolProperties, ToolProperties$Outbound } from "./toolproperties.js";
export type RequiresConfirmation = LogicalExpression | ToolProperties | Array<string>;
export type SkipConfirmation = LogicalExpression | ToolProperties | Array<string>;
export type ToolExecutionConfiguration = {
    requiresConfirmation?: LogicalExpression | ToolProperties | Array<string> | null | undefined;
    skipConfirmation?: LogicalExpression | ToolProperties | Array<string> | null | undefined;
    include?: Array<string> | null | undefined;
    exclude?: Array<string> | null | undefined;
};
/** @internal */
export declare const RequiresConfirmation$inboundSchema: z.ZodType<RequiresConfirmation, unknown>;
/** @internal */
export type RequiresConfirmation$Outbound = LogicalExpression$Outbound | ToolProperties$Outbound | Array<string>;
/** @internal */
export declare const RequiresConfirmation$outboundSchema: z.ZodType<RequiresConfirmation$Outbound, RequiresConfirmation>;
export declare function requiresConfirmationToJSON(requiresConfirmation: RequiresConfirmation): string;
export declare function requiresConfirmationFromJSON(jsonString: string): SafeParseResult<RequiresConfirmation, SDKValidationError>;
/** @internal */
export declare const SkipConfirmation$inboundSchema: z.ZodType<SkipConfirmation, unknown>;
/** @internal */
export type SkipConfirmation$Outbound = LogicalExpression$Outbound | ToolProperties$Outbound | Array<string>;
/** @internal */
export declare const SkipConfirmation$outboundSchema: z.ZodType<SkipConfirmation$Outbound, SkipConfirmation>;
export declare function skipConfirmationToJSON(skipConfirmation: SkipConfirmation): string;
export declare function skipConfirmationFromJSON(jsonString: string): SafeParseResult<SkipConfirmation, SDKValidationError>;
/** @internal */
export declare const ToolExecutionConfiguration$inboundSchema: z.ZodType<ToolExecutionConfiguration, unknown>;
/** @internal */
export type ToolExecutionConfiguration$Outbound = {
    requires_confirmation?: LogicalExpression$Outbound | ToolProperties$Outbound | Array<string> | null | undefined;
    skip_confirmation?: LogicalExpression$Outbound | ToolProperties$Outbound | Array<string> | null | undefined;
    include?: Array<string> | null | undefined;
    exclude?: Array<string> | null | undefined;
};
/** @internal */
export declare const ToolExecutionConfiguration$outboundSchema: z.ZodType<ToolExecutionConfiguration$Outbound, ToolExecutionConfiguration>;
export declare function toolExecutionConfigurationToJSON(toolExecutionConfiguration: ToolExecutionConfiguration): string;
export declare function toolExecutionConfigurationFromJSON(jsonString: string): SafeParseResult<ToolExecutionConfiguration, SDKValidationError>;
//# sourceMappingURL=toolexecutionconfiguration.d.ts.map