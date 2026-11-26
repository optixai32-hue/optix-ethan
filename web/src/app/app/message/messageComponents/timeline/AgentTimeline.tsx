"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { StopReason } from "@/app/app/services/streamingModels";
import {
  FullChatState,
} from "@/app/app/message/messageComponents/types";
import { TurnGroup } from "./transformers";
import { cn } from "@opal/utils";
import AgentAvatar from "@/refresh-components/avatars/AgentAvatar";
import { Button, Collapsible, Text } from "@opal/components";
import { TextLoader } from "@opal/loaders";
import { SvgCheckCircle, SvgExpand, SvgFold, SvgLoader } from "@opal/icons";
import { Section } from "@opal/layouts";
import { useTimelineExpansion } from "@/app/app/message/messageComponents/timeline/hooks/useTimelineExpansion";
import { useTimelineMetrics } from "@/app/app/message/messageComponents/timeline/hooks/useTimelineMetrics";
import {
  useTimelineHeader,
  useActivitySteps,
} from "@/app/app/message/messageComponents/timeline/hooks/useTimelineHeader";
import {
  useTimelineUIState,
  TimelineUIState,
} from "@/app/app/message/messageComponents/timeline/hooks/useTimelineUIState";
import { TimelineRoot } from "@/app/app/message/messageComponents/timeline/primitives/TimelineRoot";
import { TimelineHeaderRow } from "@/app/app/message/messageComponents/timeline/primitives/TimelineHeaderRow";

// =============================================================================
// Private Wrapper Components
// =============================================================================

interface TimelineContainerProps {
  agent: FullChatState["agent"];
  headerContent?: React.ReactNode;
  children?: React.ReactNode;
}

function TimelineContainer({
  agent,
  headerContent,
  children,
}: TimelineContainerProps) {
  return (
    <TimelineRoot>
      <TimelineHeaderRow left={<AgentAvatar agent={agent} size={24} />}>
        {headerContent}
      </TimelineHeaderRow>
      {children}
    </TimelineRoot>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export interface AgentTimelineProps {
  /** Turn groups from usePacketProcessor */
  turnGroups: TurnGroup[];
  /** Chat state for rendering content */
  chatState: FullChatState;
  /** Whether the stop packet has been seen */
  stopPacketSeen?: boolean;
  /** Reason for stopping (if stopped) */
  stopReason?: StopReason;
  /** Whether final answer is coming (affects last connector) */
  finalAnswerComing?: boolean;
  /** Whether there is display content after timeline */
  hasDisplayContent?: boolean;
  /** Content to render after timeline (final message + toolbar) - slot pattern */
  children?: React.ReactNode;
  /** Whether the timeline is collapsible */
  collapsible?: boolean;
  /** Title of the button to toggle the timeline */
  buttonTitle?: string;
  /** Test ID for e2e testing */
  "data-testid"?: string;
  /** Processing duration in seconds (for completed messages) */
  processingDurationSeconds?: number;
  /** Whether image generation is in progress */
  isGeneratingImage?: boolean;
  /** Number of images generated */
  generatedImageCount?: number;
  /** Tool processing duration from backend (via MESSAGE_START packet) */
  toolProcessingDuration?: number;
}

/**
 * Custom prop comparison for AgentTimeline memoization.
 * Prevents unnecessary re-renders when parent renders but props haven't meaningfully changed.
 */
function areAgentTimelinePropsEqual(
  prev: AgentTimelineProps,
  next: AgentTimelineProps
): boolean {
  return (
    prev.turnGroups === next.turnGroups &&
    prev.stopPacketSeen === next.stopPacketSeen &&
    prev.stopReason === next.stopReason &&
    prev.finalAnswerComing === next.finalAnswerComing &&
    prev.hasDisplayContent === next.hasDisplayContent &&
    prev.processingDurationSeconds === next.processingDurationSeconds &&
    prev.collapsible === next.collapsible &&
    prev.buttonTitle === next.buttonTitle &&
    prev.chatState === next.chatState &&
    prev.isGeneratingImage === next.isGeneratingImage &&
    prev.generatedImageCount === next.generatedImageCount &&
    prev.toolProcessingDuration === next.toolProcessingDuration
  );
}

export const AgentTimeline = React.memo(function AgentTimeline({
  turnGroups,
  chatState,
  stopPacketSeen = false,
  stopReason,
  finalAnswerComing = false,
  hasDisplayContent = false,
  collapsible = true,
  buttonTitle: _buttonTitle,
  "data-testid": _testId,
  processingDurationSeconds: _processingDurationSeconds,
  isGeneratingImage = false,
  generatedImageCount: _generatedImageCount,
  toolProcessingDuration: _toolProcessingDuration,
}: AgentTimelineProps) {
  const t = useTranslations("chat.messages.timeline");

  // The header label and the disclosed list share the very same activity
  // names, all derived from real packets by useTimelineHeader's helpers.
  const { headerText, hasPackets, userStopped } = useTimelineHeader(
    turnGroups,
    stopReason,
    isGeneratingImage
  );
  const activitySteps = useActivitySteps(turnGroups);

  // Starts collapsed. Only the toggle button changes this state: no effect
  // reacts to a new step, streaming completion or the final answer.
  const { isExpanded, handleToggle } = useTimelineExpansion(
    stopPacketSeen,
    undefined,
    hasDisplayContent
  );

  const { lastTurnGroup, lastStep } = useTimelineMetrics(turnGroups, userStopped);
  const { uiState, isStreaming } = useTimelineUIState({
    stopPacketSeen,
    hasPackets,
    hasDisplayContent,
    userStopped,
    isExpanded,
    lastTurnGroup,
    // The collapsed preview and the detailed step bodies are deliberately
    // gone: the disclosure contains nothing but the activity names.
    lastStep: undefined,
    lastStepSupportsCollapsedStreaming: false,
    lastStepHasCollapsedContent: false,
    lastStepIsResearchAgent: false,
    parallelActiveStepSupportsCollapsedStreaming: false,
    parallelActiveStepHasCollapsedContent: false,
    isGeneratingImage,
    finalAnswerComing,
  });

  // Display content only (no timeline steps) - but show header for image generation
  if (uiState === TimelineUIState.DISPLAY_CONTENT_ONLY) {
    return <TimelineContainer agent={chatState.agent} />;
  }

  const processing =
    (isStreaming || uiState === TimelineUIState.EMPTY) && !stopPacketSeen;
  const canToggle = collapsible && activitySteps.length > 0;

  const header = (
    <div
      className={cn(
        "flex flex-1 min-w-0 h-full items-center justify-between p-1 rounded-t-12 transition-colors duration-300",
        canToggle && "hover:bg-background-tint-00"
      )}
    >
      <div className="min-w-0 px-(--timeline-header-text-padding-x) py-(--timeline-header-text-padding-y)">
        {processing ? (
          <TextLoader font="main-ui-muted">{headerText}</TextLoader>
        ) : (
          <Text font="main-ui-muted" color="text-04">
            {headerText}
          </Text>
        )}
      </div>
      {canToggle && (
        <Button
          prominence="tertiary"
          size="md"
          icon={isExpanded ? SvgFold : SvgExpand}
          onClick={handleToggle}
          aria-label={
            isExpanded
              ? t("collapseButton.ariaLabel")
              : t("expandButton.ariaLabel")
          }
          aria-expanded={isExpanded}
        />
      )}
    </div>
  );

  return (
    <TimelineContainer agent={chatState.agent} headerContent={header}>
      <Collapsible.Root open={isExpanded}>
        <Collapsible.Content paddingTop={2}>
          <Section
            flexDirection="column"
            alignItems="stretch"
            justifyContent="start"
            gap={1}
            height="auto"
          >
            {activitySteps.map((step) => {
              // Only the step the stream is actually executing shimmers.
              const running = isStreaming && lastStep?.key === step.key;
              return (
                <Section
                  key={step.key}
                  flexDirection="row"
                  alignItems="center"
                  justifyContent="start"
                  gap={1}
                  width="fit"
                  height="auto"
                >
                  {running ? (
                    <SvgLoader
                      size={14}
                      className="shrink-0 motion-safe:animate-spin"
                    />
                  ) : (
                    <SvgCheckCircle size={14} className="shrink-0" />
                  )}
                  {running ? (
                    <TextLoader font="main-ui-muted">{step.name}</TextLoader>
                  ) : (
                    <Text font="main-ui-muted" color="text-04">
                      {step.name}
                    </Text>
                  )}
                </Section>
              );
            })}
          </Section>
        </Collapsible.Content>
      </Collapsible.Root>
    </TimelineContainer>
  );
}, areAgentTimelinePropsEqual);

export default AgentTimeline;
