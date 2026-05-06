import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

export class UpdateClusterTool extends AtlasToolBase {
    static toolName = "atlas-update-cluster";
    static operationType: OperationType = "update";
    public description =
        "Update an existing MongoDB Atlas cluster. Can pause or resume a cluster, change instance size, toggle backup, or configure auto-scaling. Provide either projectId or projectName to identify the target project. At least one update field must be provided.";

    public argsShape = {
        projectId: AtlasArgs.projectId()
            .optional()
            .describe("Atlas project ID. Provide either this or projectName."),
        projectName: z
            .string()
            .optional()
            .describe("Atlas project name. Provide either this or projectId."),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to update"),
        paused: z
            .boolean()
            .optional()
            .describe("Set to true to pause the cluster, false to resume it. Cluster must be in IDLE state to pause."),
        instanceSize: z
            .string()
            .optional()
            .describe("New instance size (e.g. M20, M30). Scales the cluster up or down."),
        backupEnabled: z.boolean().optional().describe("Enable or disable cloud backup for the cluster"),
        computeAutoScalingEnabled: z
            .boolean()
            .optional()
            .describe("Enable or disable compute auto-scaling (instance size) for the cluster."),
        diskAutoScalingEnabled: z
            .boolean()
            .optional()
            .describe("Enable or disable disk auto-scaling for the cluster"),
    };

    protected async execute({
        projectId,
        projectName,
        clusterName,
        paused,
        instanceSize,
        backupEnabled,
        computeAutoScalingEnabled,
        diskAutoScalingEnabled,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const instanceSizeLadder = ["M10", "M20", "M30", "M40", "M50", "M60", "M80", "M140", "M200", "M300", "M400", "M700"];
        const getMaxInstanceSize = (min: string): string => {
            const idx = instanceSizeLadder.indexOf(min);
            return idx === -1 ? "M40" : (instanceSizeLadder[Math.min(idx + 2, instanceSizeLadder.length - 1)] ?? "M40");
        };
        if (!projectId && !projectName) {
            return {
                content: [{ type: "text", text: "Either projectId or projectName must be provided." }],
                isError: true,
            };
        }

        if (
            paused === undefined &&
            instanceSize === undefined &&
            backupEnabled === undefined &&
            computeAutoScalingEnabled === undefined &&
            diskAutoScalingEnabled === undefined
        ) {
            return {
                content: [{ type: "text", text: "At least one update field must be provided." }],
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

        const body: Record<string, unknown> = {};
        if (paused !== undefined) body.paused = paused;
        if (backupEnabled !== undefined) body.backupEnabled = backupEnabled;
        if (instanceSize !== undefined || computeAutoScalingEnabled !== undefined || diskAutoScalingEnabled !== undefined) {
            const existing = await this.apiClient.getCluster({
                params: { path: { groupId: resolvedProjectId!, clusterName } },
            });
            const existingSpecs = existing.replicationSpecs ?? [];
            body.replicationSpecs = existingSpecs.map(({ id: _specId, ...spec }) => ({
                ...spec,
                regionConfigs: (spec.regionConfigs ?? []).map(({ ...rc }) => ({
                    ...rc,
                    ...(instanceSize !== undefined ? { electableSpecs: { ...rc.electableSpecs, instanceSize } } : {}),
                    autoScaling: {
                        ...rc.autoScaling,
                        ...(computeAutoScalingEnabled !== undefined
                            ? {
                                  compute: {
                                      enabled: computeAutoScalingEnabled,
                                      scaleDownEnabled: computeAutoScalingEnabled,
                                      minInstanceSize: instanceSize ?? (rc.electableSpecs?.instanceSize ?? "M10"),
                                      maxInstanceSize: getMaxInstanceSize(instanceSize ?? (rc.electableSpecs?.instanceSize ?? "M10")),
                                  },
                              }
                            : {}),
                        ...(diskAutoScalingEnabled !== undefined ? { diskGB: { enabled: diskAutoScalingEnabled } } : {}),
                    },
                })),
            }));
        }

        await this.apiClient.updateCluster(resolvedProjectId!, clusterName, body);

        const changes: string[] = [];
        if (paused !== undefined) changes.push(paused ? "paused" : "resumed");
        if (instanceSize !== undefined) changes.push(`scaled to ${instanceSize}`);
        if (computeAutoScalingEnabled !== undefined) changes.push(`compute auto-scaling ${computeAutoScalingEnabled ? "enabled" : "disabled"}`);
        if (diskAutoScalingEnabled !== undefined) changes.push(`disk auto-scaling ${diskAutoScalingEnabled ? "enabled" : "disabled"}`);
        if (backupEnabled !== undefined) changes.push(`backup ${backupEnabled ? "enabled" : "disabled"}`);

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${clusterName}" has been ${changes.join(", ")}.`,
                },
            ],
        };
    }
}
