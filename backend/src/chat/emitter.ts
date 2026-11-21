/**
 * StreamEmitter — TypeScript port of backend/onyx/chat/emitter.py.
 *
 * The current Python emitter.py is a thin wrapper that tags each Packet with a
 * model index before delivery (`Emitter.emit` publishes
 * `packet.model_copy(update={"placement": ...})`); the stream itself is a
 * packet sequence consumed as SSE by the web frontend. This port keeps the
 * classic StreamEmitter shape used by the chat turn: an in-memory buffer of
 * ordered Packets (seq/ind/type/message envelope — see chat/models.ts), with:
 *   - send(type, ind, message)               — simple string packets
 *   - sendObject(type, ind, obj)             — structured packets (JSON in `packet`)
 *   - error(message) / stop(ind)             — StreamingError / OverallStop semantics
 *   - subscribe(callback)                    — live delivery for SSE
 *   - toJSONL()                              — newline-delimited JSON replay
 */

import type { Packet, PacketType } from "./models";

export type PacketSubscriber = (packet: Packet) => void;

export interface StreamEmitterOptions {
  /** Port of emitter.py `model_idx`: tagged onto every published packet. */
  modelIdx?: number;
  /** Called for every packet in emission order (live SSE delivery). */
  onPacket?: PacketSubscriber;
}

export class StreamEmitter {
  private packets: Packet[] = [];
  private seq = 0;
  private readonly modelIdx: number;
  private subscriber: PacketSubscriber | null = null;

  constructor(opts: StreamEmitterOptions = {}) {
    this.modelIdx = opts.modelIdx ?? 0;
    if (opts.onPacket) {
      this.subscriber = opts.onPacket;
    }
  }

  /** Register (or replace) the live packet sink. */
  subscribe(fn: PacketSubscriber): void {
    this.subscriber = fn;
  }

  /**
   * Emit a simple (message-carrying) packet. Port of the classic emitter's
   * simple-string path: `packet` stays empty, `message` carries the payload.
   */
  send(type: PacketType, ind: number, message: string): Packet {
    return this.publish(type, ind, message, "");
  }

  /**
   * Emit with a free-form type string — used to forward tool progress packet
   * types that arrive through the ToolContext.emit contract.
   */
  sendRaw(type: string, ind: number, message: string): Packet {
    return this.publish(type as PacketType, ind, message, "");
  }

  /**
   * Emit a structured packet nested under a sub-turn (Deep Research research
   * agent tool calls — placement.sub_turn_index on the wire).
   */
  sendObjectSub(type: PacketType, ind: number, subInd: number, obj: unknown): Packet {
    return this.publishSub(type, ind, subInd, "", JSON.stringify(obj));
  }

  /** Forward a raw tool packet under a sub-turn (ToolContext.emit path). */
  sendRawSub(type: string, ind: number, subInd: number, message: string): Packet {
    return this.publishSub(type as PacketType, ind, subInd, message, "");
  }

  /**
   * Emit a structured packet: the payload object is JSON-serialized into the
   * `packet` field (port of the classic `Packet(packet=obj.model_dump_json())`).
   */
  sendObject(type: PacketType, ind: number, obj: unknown, message = ""): Packet {
    return this.publish(type, ind, message, JSON.stringify(obj));
  }

  /** Port of StreamingError semantics from streaming_models.py. */
  error(ind: number, message: string, errorCode: string | null = null, isRetryable = false): Packet {
    return this.sendObject("error", ind, {
      error: message,
      error_code: errorCode,
      is_retryable: isRetryable,
    });
  }

  /** Port of OverallStop (streaming_models.py lines 127-129). */
  stop(ind: number, stopReason: string | null = null): Packet {
    return this.sendObject("stop", ind, { stop_reason: stopReason });
  }

  /** Port of heartbeat_packet() (streaming_models.py lines 701-703). */
  heartbeat(ind: number): Packet {
    return this.send("chat_heartbeat", ind, "");
  }

  private publish(
    type: PacketType,
    ind: number,
    message: string,
    packetJson: string,
  ): Packet {
    this.seq += 1;
    const packet: Packet = {
      seq: this.seq,
      packet: packetJson,
      ind,
      type,
      message,
    };
    this.packets.push(packet);
    if (this.subscriber) {
      try {
        this.subscriber(packet);
      } catch {
        // A throwing subscriber must never break the emission loop; the
        // packet is still buffered for toJSONL replay.
      }
    }
    void this.modelIdx; // retained for parity with emitter.py's model_idx tagging
    return packet;
  }

  private publishSub(
    type: PacketType,
    ind: number,
    subInd: number,
    message: string,
    packetJson: string,
  ): Packet {
    this.seq += 1;
    const packet: Packet = {
      seq: this.seq,
      packet: packetJson,
      ind,
      subInd,
      type,
      message,
    };
    this.packets.push(packet);
    if (this.subscriber) {
      try {
        this.subscriber(packet);
      } catch {
        // A throwing subscriber must never break the emission loop.
      }
    }
    return packet;
  }

  /** All packets in emission order (replay buffer). */
  getPackets(): Packet[] {
    return [...this.packets];
  }

  /** Newline-delimited JSON serialization of the full packet sequence. */
  toJSONL(): string {
    return this.packets.map((p) => JSON.stringify(p)).join("\n");
  }
}
