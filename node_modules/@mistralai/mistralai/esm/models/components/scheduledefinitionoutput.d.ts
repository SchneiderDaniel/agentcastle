import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ScheduleCalendar } from "./schedulecalendar.js";
import { ScheduleFutureExecution } from "./schedulefutureexecution.js";
import { ScheduleInterval } from "./scheduleinterval.js";
import { SchedulePolicy } from "./schedulepolicy.js";
import { ScheduleRecentExecution } from "./schedulerecentexecution.js";
/**
 * Output representation of a schedule with required schedule_id.
 *
 * @remarks
 *
 * Used when returning schedules from the API where schedule_id is always present.
 */
export type ScheduleDefinitionOutput = {
    /**
     * Input to provide to the workflow when starting it.
     */
    input: any;
    /**
     * Calendar-based specification of times.
     */
    calendars?: Array<ScheduleCalendar> | undefined;
    /**
     * Interval-based specification of times.
     */
    intervals?: Array<ScheduleInterval> | undefined;
    /**
     * Cron-based specification of times.
     */
    cronExpressions?: Array<string> | undefined;
    /**
     * Set of calendar times to skip.
     */
    skip?: Array<ScheduleCalendar> | undefined;
    /**
     * Time after which the first action may be run.
     */
    startAt?: Date | null | undefined;
    /**
     * Time after which no more actions will be run.
     */
    endAt?: Date | null | undefined;
    /**
     * Jitter to apply each action.
     *
     * @remarks
     *
     * An action's scheduled time will be incremented by a random value between 0
     * and this value if present (but not past the next schedule).
     */
    jitter?: string | null | undefined;
    /**
     * IANA time zone name, for example ``US/Central``.
     */
    timeZoneName?: string | null | undefined;
    policy?: SchedulePolicy | undefined;
    /**
     * Unique identifier for the schedule.
     */
    scheduleId: string;
    /**
     * Remaining workflow executions before this schedule stops triggering automatically. null means unlimited; 0 means the limit has been reached and the schedule is exhausted.
     */
    remainingExecutions?: number | null | undefined;
    /**
     * Name of the workflow this schedule triggers.
     */
    workflowName: string;
    /**
     * Whether the schedule is currently paused.
     */
    paused: boolean;
    /**
     * Human-readable note associated with the current pause or resume state.
     */
    note?: string | null | undefined;
    /**
     * Upcoming scheduled executions (10 next executions, earliest first).
     */
    futureExecutions?: Array<ScheduleFutureExecution> | undefined;
    /**
     * Most recent scheduled executions (10 most recent, newest last).
     */
    recentExecutions?: Array<ScheduleRecentExecution> | undefined;
};
/** @internal */
export declare const ScheduleDefinitionOutput$inboundSchema: z.ZodType<ScheduleDefinitionOutput, unknown>;
export declare function scheduleDefinitionOutputFromJSON(jsonString: string): SafeParseResult<ScheduleDefinitionOutput, SDKValidationError>;
//# sourceMappingURL=scheduledefinitionoutput.d.ts.map