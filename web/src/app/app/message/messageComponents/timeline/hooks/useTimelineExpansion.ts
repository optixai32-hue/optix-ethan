import { useState, useEffect, useCallback } from "react";
import { TurnGroup } from "../transformers";

export interface TimelineExpansionState {
  isExpanded: boolean;
  handleToggle: () => void;
  parallelActiveTab: string;
  setParallelActiveTab: (tab: string) => void;
}

/**
 * Manages expansion state for the timeline.
 * The disclosure is owned by the user: it starts collapsed and only the
 * toggle button changes it, whatever the streaming state does.
 */
export function useTimelineExpansion(
  _stopPacketSeen: boolean,
  lastTurnGroup: TurnGroup | undefined,
  _hasDisplayContent: boolean = false
): TimelineExpansionState {
  const [isExpanded, setIsExpanded] = useState(false);
  const [parallelActiveTab, setParallelActiveTab] = useState<string>("");

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Sync active tab when parallel turn group changes
  useEffect(() => {
    if (lastTurnGroup?.isParallel && lastTurnGroup.steps.length > 0) {
      const validTabs = lastTurnGroup.steps.map((s) => s.key);
      const firstStep = lastTurnGroup.steps[0];
      if (firstStep && !validTabs.includes(parallelActiveTab)) {
        setParallelActiveTab(firstStep.key);
      }
    }
  }, [lastTurnGroup, parallelActiveTab]);

  return {
    isExpanded,
    handleToggle,
    parallelActiveTab,
    setParallelActiveTab,
  };
}
