import { ClientSDK, RequestOptions } from "../lib/sdks.js";
import * as components from "../models/components/index.js";
import * as operations from "../models/operations/index.js";
export declare class IngestionPipelineConfigurations extends ClientSDK {
    /**
     * List ingestion pipeline configurations
     *
     * @remarks
     * For the current workspace, lists all of the registered ingestion pipeline configurations.
     */
    list(options?: RequestOptions): Promise<Array<components.IngestionPipelineConfiguration>>;
    /**
     * Register Config
     *
     * @remarks
     * Register an ingestion configuration.
     */
    register(request: components.CreateIngestionPipelineConfigurationRequest, options?: RequestOptions): Promise<components.IngestionPipelineConfiguration>;
    /**
     * Update Run Info
     */
    updateRunInfo(request: operations.UpdateRunInfoV1RagIngestionPipelineConfigurationsIdRunInfoPutRequest, options?: RequestOptions): Promise<components.IngestionPipelineConfiguration>;
}
//# sourceMappingURL=ingestionpipelineconfigurations.d.ts.map