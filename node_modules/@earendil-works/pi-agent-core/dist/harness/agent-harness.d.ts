import { type AssistantMessage, type ImageContent, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.js";
import type { AbortResult, AgentHarnessEvent, AgentHarnessEventResultMap, AgentHarnessOptions, AgentHarnessOwnEvent, AgentHarnessResources, AgentHarnessStreamOptions, ExecutionEnv, NavigateTreeResult, PromptTemplate, Skill } from "./types.js";
export declare class AgentHarness<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate, TTool extends AgentTool = AgentTool> {
    readonly env: ExecutionEnv;
    private session;
    private phase;
    private runAbortController?;
    private runPromise?;
    private pendingSessionWrites;
    private model;
    private thinkingLevel;
    private systemPrompt;
    private streamOptions;
    private getApiKeyAndHeaders?;
    private resources;
    private tools;
    private activeToolNames;
    private steerQueue;
    private steeringQueueMode;
    private followUpQueue;
    private followUpQueueMode;
    private nextTurnQueue;
    private handlers;
    constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>);
    private getHandlers;
    private emitOwn;
    private emitAny;
    private emitHook;
    private emitBeforeProviderRequest;
    private emitBeforeProviderPayload;
    private emitQueueUpdate;
    private startRunPromise;
    private createTurnState;
    private createContext;
    private createStreamFn;
    private drainQueuedMessages;
    private createLoopConfig;
    private validateToolNames;
    private flushPendingSessionWrites;
    private handleAgentEvent;
    private emitRunFailure;
    private executeTurn;
    prompt(text: string, options?: {
        images?: ImageContent[];
    }): Promise<AssistantMessage>;
    skill(name: string, additionalInstructions?: string): Promise<AssistantMessage>;
    promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage>;
    steer(text: string, options?: {
        images?: ImageContent[];
    }): Promise<void>;
    followUp(text: string, options?: {
        images?: ImageContent[];
    }): Promise<void>;
    nextTurn(text: string, options?: {
        images?: ImageContent[];
    }): Promise<void>;
    appendMessage(message: AgentMessage): Promise<void>;
    compact(customInstructions?: string): Promise<{
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details?: unknown;
    }>;
    navigateTree(targetId: string, options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
    }): Promise<NavigateTreeResult>;
    getModel(): Model<any>;
    getThinkingLevel(): ThinkingLevel;
    setModel(model: Model<any>): Promise<void>;
    setThinkingLevel(level: ThinkingLevel): Promise<void>;
    setActiveTools(toolNames: string[]): Promise<void>;
    getSteeringMode(): QueueMode;
    setSteeringMode(mode: QueueMode): Promise<void>;
    getFollowUpMode(): QueueMode;
    setFollowUpMode(mode: QueueMode): Promise<void>;
    getResources(): AgentHarnessResources<TSkill, TPromptTemplate>;
    setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void>;
    getStreamOptions(): AgentHarnessStreamOptions;
    setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void>;
    setTools(tools: TTool[], activeToolNames?: string[]): Promise<void>;
    abort(): Promise<AbortResult>;
    waitForIdle(): Promise<void>;
    subscribe(listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void): () => void;
    on<TType extends keyof AgentHarnessEventResultMap>(type: TType, handler: (event: Extract<AgentHarnessOwnEvent, {
        type: TType;
    }>) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType]): () => void;
}
//# sourceMappingURL=agent-harness.d.ts.map