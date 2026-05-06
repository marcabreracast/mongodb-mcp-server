import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

export class CreateProdClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-prod-cluster";
    static operationType: OperationType = "create";
    public description =
        "Create a production-grade MongoDB Atlas cluster. Backup and termination protection are enabled by default. Supports multi-region deployments, sharded clusters, and M30+ instance sizes. Provide either projectId or projectName to identify the target project.";

    public argsShape = {
        projectId: AtlasArgs.projectId()
            .optional()
            .describe("Atlas project ID. Provide either this or projectName."),
        projectName: z
            .string()
            .optional()
            .describe("Atlas project name. Provide either this or projectId."),
        name: AtlasArgs.clusterName().describe(
            "Name of the cluster. Use a name that reflects the service and environment, e.g. 'myapp-prod', 'payments-prod'."
        ),
        instanceSize: z
            .string()
            .default("M30")
            .describe(
                "Instance size for the cluster nodes. Must be M30 or larger. Recommendations: M30 for small production workloads, M40-M50 for medium, M60+ for large."
            ),
        provider: z
            .enum(["AWS", "AZURE", "GCP"])
            .default("AWS")
            .describe("Cloud provider for the cluster"),
        regions: z
            .array(AtlasArgs.region())
            .default(["US_EAST_1"])
            .describe(
                "One or more cloud regions for the cluster. First region is the primary (priority 7, 3 nodes). Additional regions are secondaries (2 nodes each). Use multiple regions for high availability."
            ),
        clusterType: z
            .enum(["REPLICASET", "SHARDED"])
            .default("REPLICASET")
            .describe("Cluster topology. Use REPLICASET for most workloads, SHARDED for horizontal scaling."),
        numShards: z
            .number()
            .int()
            .min(1)
            .default(1)
            .describe("Number of shards. Only relevant when clusterType is SHARDED."),
        terminationProtectionEnabled: z
            .boolean()
            .default(true)
            .describe("Enable termination protection to prevent accidental deletion. Defaults to true for production."),
    };

    protected async execute({
        projectId,
        projectName,
        name,
        instanceSize,
        provider,
        regions,
        clusterType,
        numShards,
        terminationProtectionEnabled,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        if (!projectId && !projectName) {
            return {
                content: [{ type: "text", text: "Either projectId or projectName must be provided." }],
                isError: true,
            };
        }

        let resolvedProjectId = projectId;
        if (!resolvedProjectId) {
            const groups = await this.apiClient.listGroups();
            const match = groups.results?.find((g) => g.name === projectName);
            if (!match) {
                return {
                    content: [{ type: "text", text: `No project found with name "${projectName}".` }],
                    isError: true,
                };
            }
            resolvedProjectId = match.id;
        }

        const instanceSizeLadder = ["M10", "M20", "M30", "M40", "M50", "M60", "M80", "M140", "M200", "M300", "M400", "M700"];
        const getMaxInstanceSize = (min: string): string => {
            const idx = instanceSizeLadder.indexOf(min);
            return idx === -1 ? "M60" : (instanceSizeLadder[Math.min(idx + 2, instanceSizeLadder.length - 1)] ?? "M60");
        };

        const regionConfigs = regions.map((regionName, index) => ({
            providerName: provider,
            regionName,
            priority: 7 - index,
            electableSpecs: {
                instanceSize,
                nodeCount: index === 0 ? 3 : 2,
            },
            autoScaling: {
                compute: {
                    enabled: true,
                    scaleDownEnabled: true,
                    minInstanceSize: instanceSize,
                    maxInstanceSize: getMaxInstanceSize(instanceSize),
                },
                diskGB: {
                    enabled: true,
                },
            },
        }));

        const replicationSpecs = Array.from({ length: clusterType === "SHARDED" ? numShards : 1 }, () => ({
            zoneName: "Zone 1",
            regionConfigs,
        }));

        const body: unknown = {
            name,
            clusterType,
            replicationSpecs,
            backupEnabled: true,
            terminationProtectionEnabled,
        };

        await ensureCurrentIpInAccessList(this.apiClient, resolvedProjectId!);
        await this.apiClient.createCluster({
            params: { path: { groupId: resolvedProjectId! } },
            body: body as ClusterDescription20240805,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Production cluster "${name}" (${clusterType}, ${instanceSize}, ${provider} ${regions.join(", ")}) creation started in project "${projectName ?? resolvedProjectId}". It will be available in a few minutes.`,
                },
            ],
        };
    }
}
