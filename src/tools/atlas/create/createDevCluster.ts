import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

export class CreateDevClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-dev-cluster";
    static operationType: OperationType = "create";
    public description =
        "Create a non-production MongoDB Atlas cluster for development or testing. Uses M10 instance size, single region, no backup, and no termination protection. Provide either projectId or projectName to identify the target project.";

    public argsShape = {
        projectId: AtlasArgs.projectId()
            .optional()
            .describe("Atlas project ID. Provide either this or projectName."),
        projectName: z
            .string()
            .optional()
            .describe("Atlas project name. Provide either this or projectId."),
        name: AtlasArgs.clusterName().describe("Name of the cluster"),
        provider: z
            .enum(["AWS", "AZURE", "GCP"])
            .default("AWS")
            .describe("Cloud provider for the cluster"),
        region: AtlasArgs.region()
            .default("US_EAST_1")
            .describe("Cloud region for the cluster (e.g. US_EAST_1, EU_WEST_1)"),
    };

    protected async execute({
        projectId,
        projectName,
        name,
        provider,
        region,
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

        const body: unknown = {
            name,
            clusterType: "REPLICASET",
            backupEnabled: false,
            terminationProtectionEnabled: false,
            replicationSpecs: [
                {
                    zoneName: "Zone 1",
                    regionConfigs: [
                        {
                            providerName: provider,
                            regionName: region,
                            priority: 7,
                            electableSpecs: {
                                instanceSize: "M10",
                                nodeCount: 3,
                            },
                            autoScaling: {
                                compute: {
                                    enabled: true,
                                    scaleDownEnabled: true,
                                    minInstanceSize: "M10",
                                    maxInstanceSize: "M20",
                                },
                                diskGB: {
                                    enabled: true,
                                },
                            },
                        },
                    ],
                },
            ],
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
                    text: `Dev cluster "${name}" (M10, ${provider} ${region}) creation started in project "${projectName ?? resolvedProjectId}". It will be available in a few minutes.`,
                },
            ],
        };
    }
}
