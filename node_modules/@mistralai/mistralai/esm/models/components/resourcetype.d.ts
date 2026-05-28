import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
export declare const ResourceType: {
    readonly One: 1;
    readonly Two: 2;
    readonly Three: 3;
    readonly Four: 4;
};
export type ResourceType = OpenEnum<typeof ResourceType>;
/** @internal */
export declare const ResourceType$inboundSchema: z.ZodType<ResourceType, unknown>;
//# sourceMappingURL=resourcetype.d.ts.map