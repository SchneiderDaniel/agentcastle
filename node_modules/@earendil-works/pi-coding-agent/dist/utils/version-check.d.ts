export declare const MINIMUM_NODE_VERSION_FOR_LATEST_PI = "22.19.0";
export interface LatestPiRelease {
    version: string;
    packageName?: string;
}
export declare function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined;
export declare function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean;
export declare function isNodeVersionAtLeast(version: string, minimumVersion: string): boolean;
export declare function isCurrentNodeVersionSupportedByLatestPi(): boolean;
export declare function getLatestPiNodeRequirementMessage(updateCommand: string): string;
export declare function getLatestPiRelease(currentVersion: string, options?: {
    timeoutMs?: number;
}): Promise<LatestPiRelease | undefined>;
export declare function getLatestPiVersion(currentVersion: string, options?: {
    timeoutMs?: number;
}): Promise<string | undefined>;
export declare function checkForNewPiVersion(currentVersion: string): Promise<string | undefined>;
//# sourceMappingURL=version-check.d.ts.map