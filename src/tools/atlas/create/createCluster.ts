import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    static operationType: OperationType = "create";
    public description =
        "Create a dedicated MongoDB Atlas cluster. Supports replica sets and sharded clusters across AWS, Azure, and GCP. Auto-scaling is always enabled. Use instanceSize M10+ for dedicated clusters (e.g. M10 for dev, M30+ for production). Provide either projectId or projectName to identify the target project.";

    public argsShape = {
        projectId: AtlasArgs.projectId()
            .optional()
            .describe("Atlas project ID. Provide either this or projectName."),
        projectName: z
            .string()
            .optional()
            .describe("Atlas project name. Provide either this or projectId."),
        name: AtlasArgs.clusterName().describe("Name of the cluster"),
        instanceSize: z
            .string()
            .default("M10")
            .describe(
                "Instance size for the cluster nodes. Must be M10 or larger. Recommendations: M10 for dev/test or non-production workloads, M20-M30 for small production workloads, M40-M50 for medium production workloads, M60+ for large production workloads."
            ),
        provider: z
            .enum(["AWS", "AZURE", "GCP"])
            .default("AWS")
            .describe("Cloud provider for the cluster"),
        region: AtlasArgs.region()
            .default("US_EAST_1")
            .describe("Cloud region for the cluster (e.g. US_EAST_1, EU_WEST_1)"),
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
        backupEnabled: z.boolean().default(true).describe("Enable cloud backup for the cluster"),
        terminationProtectionEnabled: z
            .boolean()
            .default(false)
            .describe("Enable termination protection to prevent accidental deletion of the cluster"),
    };

    protected async execute({
        projectId,
        projectName,
        name,
        instanceSize,
        provider,
        region,
        clusterType,
        numShards,
        backupEnabled,
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

        const regionConfig = {
            providerName: provider,
            regionName: region,
            priority: 7,
            electableSpecs: {
                instanceSize,
                nodeCount: 3,
            },
            autoScaling: {
                compute: {
                    enabled: true,
                    scaleDownEnabled: true,
                    minInstanceSize: instanceSize,
                    maxInstanceSize: "M80",
                },
                diskGB: {
                    enabled: true,
                },
            },
        };

        const replicationSpecs = Array.from({ length: clusterType === "SHARDED" ? numShards : 1 }, () => ({
            zoneName: "Zone 1",
            regionConfigs: [regionConfig],
        }));

        const body: unknown = {
            name,
            clusterType,
            replicationSpecs,
            backupEnabled,
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
                    text: `Cluster "${name}" (${clusterType}, ${instanceSize}, ${provider} ${region}) creation started in project "${projectName ?? resolvedProjectId}". It will be available in a few minutes.`,
                },
            ],
        };
    }
}
