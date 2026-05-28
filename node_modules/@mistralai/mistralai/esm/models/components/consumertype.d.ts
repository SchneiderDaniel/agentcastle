import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
export declare const ConsumerType: {
    readonly User: "user";
    readonly Org: "org";
    readonly Workspace: "workspace";
    readonly System: "system";
};
export type ConsumerType = OpenEnum<typeof ConsumerType>;
/** @internal */
export declare const ConsumerType$inboundSchema: z.ZodType<ConsumerType, unknown>;
//# sourceMappingURL=consumertype.d.ts.map