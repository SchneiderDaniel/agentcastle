import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
export declare class SearchIndexes extends ClientSDK {
    /**
     * Get Search Indexes
     */
    list(options?: RequestOptions): Promise<Array<components.SearchIndexResponse>>;
    /**
     * Register Search Index
     */
    register(request: components.CreateSearchIndexInfoRequest, options?: RequestOptions): Promise<components.SearchIndexResponse>;
}
//# sourceMappingURL=searchindexes.d.ts.map