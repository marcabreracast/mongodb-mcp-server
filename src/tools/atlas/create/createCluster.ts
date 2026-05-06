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
        regions: z
            .array(AtlasArgs.region())
            .default(["US_EAST_1"])
            .describe(
                "One or more cloud regions for the cluster. First region is the primary (priority 7, 3 nodes). Additional regions are secondaries (2 nodes each). Use multiple regions for multi-region deployments with at least 5 total electable nodes."
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
        regions,
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
                    maxInstanceSize: "M80",
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
                    text: `Cluster "${name}" (${clusterType}, ${instanceSize}, ${provider} ${regions.join(", ")}) creation started in project "${projectName ?? resolvedProjectId}". It will be available in a few minutes.`,
                },
            ],
        };
    }
}
