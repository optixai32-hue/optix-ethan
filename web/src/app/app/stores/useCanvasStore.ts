import { create } from "zustand";
import type { CanvasData } from "../services/canvasUtils";

/**
 * The Deep Search canvas side panel state (chat + canvas split view).
 *
 * Driven by two sources:
 *  - the streaming watcher inside ChatCanvasPanel (auto-opens the panel while
 *    the canvas document streams, keeps the content live)
 *  - the canvas step card in the timeline (opens the panel for any canvas,
 *    including completed ones from persisted sessions)
 */
interface CanvasStore {
  visible: boolean;
  title: string;
  content: string;
  isStreaming: boolean;
  /** Assistant message (tree node id) whose canvas is displayed. */
  nodeId: number | null;
  /** Message whose canvas already auto-opened (one auto-open per message). */
  autoOpenedNodeId: number | null;
  /** Message whose panel the user explicitly closed (no re-auto-open). */
  dismissedNodeId: number | null;

  /** Open the panel for a canvas (card click / auto-open). */
  open: (data: CanvasData) => void;
  /** Close the panel (user action only). */
  close: () => void;
  /** Live stream refresh — only while the panel shows that canvas. */
  streamUpdate: (data: CanvasData) => void;
  /** Replace the content (edit save / translated document). */
  setContent: (content: string) => void;
  markAutoOpened: (nodeId: number) => void;
  /** Session switch / teardown — panel down, state cleared. */
  reset: () => void;
}

export const useCanvasStore = create<CanvasStore>()((set) => ({
  visible: false,
  title: "",
  content: "",
  isStreaming: false,
  nodeId: null,
  autoOpenedNodeId: null,
  dismissedNodeId: null,

  open: (data) =>
    set({
      visible: true,
      title: data.title,
      content: data.content,
      isStreaming: data.isStreaming,
      nodeId: data.nodeId,
    }),

  close: () =>
    set((state) => ({ visible: false, dismissedNodeId: state.nodeId })),

  streamUpdate: (data) =>
    set((state) =>
      state.visible && state.nodeId === data.nodeId
        ? {
            title: data.title,
            content: data.content,
            isStreaming: data.isStreaming,
          }
        : {},
    ),

  setContent: (content) => set({ content }),

  markAutoOpened: (nodeId) => set({ autoOpenedNodeId: nodeId }),

  reset: () =>
    set({
      visible: false,
      title: "",
      content: "",
      isStreaming: false,
      nodeId: null,
      autoOpenedNodeId: null,
      dismissedNodeId: null,
    }),
}));
