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
 *    document into the side panel — the card ITSELF stays in the timeline
 *    (the reference video keeps every canvas step visible in the pile; only
 *    the panel opens beside the chat)
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
  /** A toolbar action waiting for the chat bridge. */
  pendingAction: CanvasPendingAction | null;

  /** Expand the card's canvas into the side panel. */
  open: (data: CanvasData) => void;
  /** Fold the panel — the timeline card stays where it is (user action only). */
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
  pendingAction: null,

  open: (data) =>
    set({
      visible: true,
      title: data.title,
      content: data.content,
      isStreaming: data.isStreaming,
      nodeId: data.nodeId,
    }),

  close: () => set({ visible: false }),

  streamUpdate: (data) =>
    set((state) => {
      if (!state.visible) return {};
      if (state.nodeId !== data.nodeId && !data.isStreaming) return {};
      // While an updated canvas is still being written (its first deltas have
      // not arrived yet), keep the current document on screen — the floating
      // "Writing the canvas…" badge signals the update in progress, and the
      // new version replaces the old one only once it actually streams in
      // (blanking the panel for the whole LLM call looks like a freeze).
      const content =
        !data.content.trim() && state.content.trim()
          ? state.content
          : data.content;
      return {
        title: data.title,
        content,
        isStreaming: data.isStreaming,
        nodeId: data.nodeId,
      };
    }),

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
      pendingAction: null,
    }),
}));
