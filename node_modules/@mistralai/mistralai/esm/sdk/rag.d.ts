import { ClientSDK } from "../lib/sdks.js";
import { IngestionPipelineConfigurations } from "./ingestionpipelineconfigurations.js";
import { SearchIndexes } from "./searchindexes.js";
export declare class Rag extends ClientSDK {
    private _ingestionPipelineConfigurations?;
    get ingestionPipelineConfigurations(): IngestionPipelineConfigurations;
    private _searchIndexes?;
    get searchIndexes(): SearchIndexes;
}
//# sourceMappingURL=rag.d.ts.map