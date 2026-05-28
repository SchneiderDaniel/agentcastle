import * as z from "zod/v4";
export type UpdateRunInfo = {
    executionTime: Date;
    chunksCount: number;
};
/** @internal */
export type UpdateRunInfo$Outbound = {
    execution_time: string;
    chunks_count: number;
};
/** @internal */
export declare const UpdateRunInfo$outboundSchema: z.ZodType<UpdateRunInfo$Outbound, UpdateRunInfo>;
export declare function updateRunInfoToJSON(updateRunInfo: UpdateRunInfo): string;
//# sourceMappingURL=updateruninfo.d.ts.map