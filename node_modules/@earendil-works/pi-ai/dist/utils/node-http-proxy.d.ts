import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
export interface NodeHttpProxyAgents {
    httpAgent: HttpAgent;
    httpsAgent: HttpsAgent;
}
export declare const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE = "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";
export declare function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined;
export declare function createHttpProxyAgentsForTarget(targetUrl: string | URL): NodeHttpProxyAgents | undefined;
//# sourceMappingURL=node-http-proxy.d.ts.map