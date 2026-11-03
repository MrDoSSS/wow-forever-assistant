// Captured image -> frame -> reassembled message -> bridge reception.
import type { InboundMessage, RouteResult } from '../app/router.js';
import type { Clock } from '../clock.js';
import type { Diagnostics } from '../diagnostics.js';
import type { CapturedImage } from './capture.js';
import { decodePixels, parseFrame, Reassembler, type ReassemblerLimits } from './frame.js';

export interface ReceiverStats {
  images: number;
  frames: number;
  rejectedFrames: number;
  messages: number;
}

export class FrameReceiver {
  private readonly reassembler: Reassembler;
  private readonly rejections = new Map<string, number>();
  private lastReportAt = 0;
  readonly stats: ReceiverStats = { images: 0, frames: 0, rejectedFrames: 0, messages: 0 };

  constructor(
    private readonly deps: {
      receive: (message: InboundMessage) => RouteResult;
      clock: Clock;
      diag: Diagnostics;
      limits?: ReassemblerLimits;
    },
  ) {
    this.reassembler = new Reassembler(deps.clock, deps.limits);
  }

  onImage(image: CapturedImage): RouteResult | null {
    this.stats.images++;
    const pixels = decodePixels(image.rgb, image.width, image.height);
    if (!pixels.ok) {
      // no_frame means the field is hidden while idle or obscured, not a transport error.
      if (pixels.reason !== 'no_frame') this.reject(pixels.reason);
      return null;
    }
    return this.onFrame(pixels.frame);
  }

  /** The silent voice carries exactly the same checked frame bytes as capture. */
  onFrame(bytes: Uint8Array): RouteResult | null {
    const frame = parseFrame(bytes);
    if (!frame.ok) {
      this.reject(frame.reason);
      return null;
    }
    this.stats.frames++;
    const assembled = this.reassembler.add(frame.header, frame.payload);
    if (assembled.status === 'conflict' || assembled.status === 'overflow') {
      this.reject(`assembly_${assembled.status}`);
      return null;
    }
    if (assembled.status !== 'complete') return null;
    this.stats.messages++;
    return this.deps.receive(assembled.message);
  }

  /** Count rejections and report them at most once every 10 seconds. */
  private reject(reason: string): void {
    this.stats.rejectedFrames++;
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
    const now = this.deps.clock.now();
    if (now - this.lastReportAt < 10_000) return;
    this.lastReportAt = now;
    this.deps.diag.warn('capture.frames_rejected', Object.fromEntries(this.rejections));
    this.rejections.clear();
  }
}
