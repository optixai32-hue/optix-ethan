import { create } from "zustand";
import type { CanvasData } from "../services/canvasUtils";

/** A canvas toolbar action waiting to be submitted as a pill message. */
export interface CanvasPendingAction {
  /** Monotonic id (Date.now) so the bridge can consume exactly one action. */
  id: number;
  /** The pill message text (without the [canvas] marker). */
  text: string;
}

/**
 * The Deep Search canvas side panel state (chat + canvas split view).
 *
 * Driven by three sources:
 *  - the canvas card in the message timeline: "Agrandir" expands the card's
 *    document into the side panel (and the card collapses to the compact
 *    pill); clicking the pill again folds the panel back into the card
 *  - the stream watcher inside ChatCanvasPanel: while the panel is open it
 *    follows the live document (canvas updates included)
 *  - the panel toolbar: refinement/translate actions enqueue pill messages
 *    (consumed by the AppPage bridge and submitted through the normal chat
 *    flow)
 */
interface CanvasStore {
  visible: boolean;
  title: string;
  content: string;
  isStreaming: boolean;
  /** Assistant message (tree node id) whose canvas is displayed. */
  nodeId: number | null;
  /**
   * Message whose canvas is expanded in the split view — the timeline card
   * renders as the compact pill while this is set (the reference video's
   * collapsed state).
   */
  expandedNodeId: number | null;
  /** A toolbar action waiting for the chat bridge. */
  pendingAction: CanvasPendingAction | null;

  /** Expand the card's canvas into the side panel. */
  open: (data: CanvasData) => void;
  /** Fold the panel back into the timeline card (user action only). */
  close: () => void;
  /** Live stream refresh — while the panel shows that canvas, and any
   * newly-streaming canvas while the panel stays open. */
  streamUpdate: (data: CanvasData) => void;
  /** Replace the content (edit save inside the panel). */
  setContent: (content: string) => void;
  /** Queue a toolbar action as a pill message. */
  enqueueAction: (text: string) => void;
  /** The bridge consumed the queued action. */
  consumeAction: (id: number) => void;
  /** Session switch / teardown — panel down, state cleared. */
  reset: () => void;
}

export const useCanvasStore = create<CanvasStore>()((set) => ({
  visible: false,
  title: "",
  content: "",
  isStreaming: false,
  nodeId: null,
  expandedNodeId: null,
  pendingAction: null,

  open: (data) =>
    set({
      visible: true,
      title: data.title,
      content: data.content,
      isStreaming: data.isStreaming,
      nodeId: data.nodeId,
      expandedNodeId: data.nodeId,
    }),

  close: () =>
    set((state) => ({ visible: false, expandedNodeId: null, nodeId: state.nodeId })),

  streamUpdate: (data) =>
    set((state) =>
      state.visible && (state.nodeId === data.nodeId || data.isStreaming)
        ? {
            title: data.title,
            content: data.content,
            isStreaming: data.isStreaming,
            nodeId: data.nodeId,
            expandedNodeId: data.nodeId,
          }
        : {},
    ),

  setContent: (content) => set({ content }),

  enqueueAction: (text) =>
    set({ pendingAction: { id: Date.now(), text } }),

  consumeAction: (id) =>
    set((state) =>
      state.pendingAction && state.pendingAction.id === id
        ? { pendingAction: null }
        : {},
    ),

  reset: () =>
    set({
      visible: false,
      title: "",
      content: "",
      isStreaming: false,
      nodeId: null,
      expandedNodeId: null,
      pendingAction: null,
    }),
}));
