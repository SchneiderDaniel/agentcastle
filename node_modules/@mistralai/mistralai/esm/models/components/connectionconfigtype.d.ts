import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
export declare const ConnectionConfigType: {
    readonly Mcp: "mcp";
    readonly Turbine: "turbine";
    readonly Eolienne: "eolienne";
};
export type ConnectionConfigType = OpenEnum<typeof ConnectionConfigType>;
/** @internal */
export declare const ConnectionConfigType$inboundSchema: z.ZodType<ConnectionConfigType, unknown>;
//# sourceMappingURL=connectionconfigtype.d.ts.map