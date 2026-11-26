import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { TurnGroup, TransformedStep } from "../transformers";
import {
  PacketType,
  SearchToolPacket,
  StopReason,
  CustomToolStart,
} from "@/app/app/services/streamingModels";
import {
  constructCurrentSearchState,
} from "@/app/app/message/messageComponents/timeline/renderers/search/searchStateUtils";

export interface TimelineHeaderResult {
  headerText: string;
  hasPackets: boolean;
  userStopped: boolean;
}

export interface ActivityStep {
  /** The step's stable key from the packet stream. */
  key: string;
  /** A translated activity name derived from an actual packet. */
  name: string;
}

/**
 * The activity names of the steps that actually happened, in stream order.
 * Every name comes from a real packet in the timeline: a step whose first
 * packet we cannot name produces no row, so nothing is invented. Internal
 * document search stays silent, as in the current product decision.
 */
export function useActivitySteps(turnGroups: TurnGroup[]): ActivityStep[] {
  const t = useTranslations("chat.messages.timeline");

  return useMemo(() => {
    const steps: ActivityStep[] = [];

    for (const turn of turnGroups) {
      for (const step of turn.steps) {
        const firstPacket = step.packets[0];
        if (!firstPacket) continue;

        const packetType = firstPacket.obj.type;
        let name: string | null = null;

        if (packetType === PacketType.SEARCH_TOOL_START) {
          const searchState = constructCurrentSearchState(
            step.packets as SearchToolPacket[]
          );
          if (searchState.isInternetSearch) {
            name = t("header.searchingWeb.label");
          }
        } else if (packetType === PacketType.FETCH_TOOL_START) {
          name = t("header.reading.label");
        } else if (packetType === PacketType.PYTHON_TOOL_START) {
          name = t("header.executingCode.label");
        } else if (packetType === PacketType.IMAGE_GENERATION_TOOL_START) {
          name = t("header.generatingImages.label");
        } else if (packetType === PacketType.FILE_READER_START) {
          name = t("header.readingFile.label");
        } else if (packetType === PacketType.CUSTOM_TOOL_START) {
          const toolName = (firstPacket.obj as CustomToolStart).tool_name;
          name = toolName
            ? t("header.executingNamedTool.label", { toolName })
            : t("header.executingTool.label");
        } else if (
          packetType === PacketType.MEMORY_TOOL_START ||
          packetType === PacketType.MEMORY_TOOL_NO_ACCESS
        ) {
          name = t("header.updatingMemory.label");
        } else if (packetType === PacketType.REASONING_START) {
          name = t("header.thinking.label");
        } else if (packetType === PacketType.DEEP_RESEARCH_PLAN_START) {
          name = t("header.generatingPlan.label");
        } else if (packetType === PacketType.RESEARCH_AGENT_START) {
          name = t("header.researching.label");
        }

        if (name !== null) {
          steps.push({ key: step.key, name });
        }
      }
    }

    return steps;
  }, [turnGroups, t]);
}

/**
 * Hook that determines timeline header state based on current activity.
 * Returns the current activity name, whether there are packets, and whether
 * the user stopped. It uses the same activity names as the disclosure list.
 */
export function useTimelineHeader(
  turnGroups: TurnGroup[],
  stopReason?: StopReason,
  isGeneratingImage?: boolean
): TimelineHeaderResult {
  const t = useTranslations("chat.messages.timeline");
  const activitySteps = useActivitySteps(turnGroups);

  return useMemo(() => {
    const hasPackets = turnGroups.length > 0;
    const userStopped = stopReason === StopReason.USER_CANCELLED;
    const thinkingHeader = t("header.thinkingEllipsis.label");

    // If generating image with no tool packets, show image generation header
    if (isGeneratingImage && !hasPackets) {
      return {
        headerText: t("header.generatingImage.label"),
        hasPackets,
        userStopped,
      };
    }

    if (!hasPackets) {
      return { headerText: thinkingHeader, hasPackets, userStopped };
    }

    // Get the last (current) turn group
    const currentTurn = turnGroups[turnGroups.length - 1];
    if (!currentTurn) {
      return { headerText: thinkingHeader, hasPackets, userStopped };
    }

    const currentStep: TransformedStep | undefined = currentTurn.steps[0];
    if (!currentStep?.packets?.length) {
      return { headerText: thinkingHeader, hasPackets, userStopped };
    }

    const currentActivity = activitySteps.find(
      (step) => step.key === currentStep.key
    );

    return {
      headerText: currentActivity?.name ?? thinkingHeader,
      hasPackets,
      userStopped,
    };
  }, [turnGroups, stopReason, isGeneratingImage, t, activitySteps]);
}
