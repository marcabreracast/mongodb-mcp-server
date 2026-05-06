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
        "Create a dedicated MongoDB Atlas cluster. Supports replica sets and sharded clusters across AWS, Azure, and GCP. Auto-scaling is always enabled. Use instanceSize M10+ for dedicated clusters (e.g. M10 for dev, M30+ for production).";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        name: AtlasArgs.clusterName().describe("Name of the cluster"),
        instanceSize: z
            .string()
            .default("M10")
            .describe(
                "Instance size for the cluster nodes (e.g. M10 for dev, M30 for production). Must be M10 or larger for dedicated clusters."
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
        backupEnabled: z.boolean().default(false).describe("Enable cloud backup for the cluster"),
        mongoDBMajorVersion: z
            .string()
            .optional()
            .describe("MongoDB major version (e.g. '8.0'). Defaults to the latest stable version if omitted."),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
        provider,
        region,
        clusterType,
        numShards,
        backupEnabled,
        mongoDBMajorVersion,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
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
            terminationProtectionEnabled: false,
            ...(mongoDBMajorVersion ? { mongoDBMajorVersion } : {}),
        };

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body: body as ClusterDescription20240805,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${name}" (${clusterType}, ${instanceSize}, ${provider} ${region}) creation started. It will be available in a few minutes.`,
                },
            ],
        };
    }
}
