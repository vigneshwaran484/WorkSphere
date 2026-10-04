export class StreamQualityMonitor {
  private peerConnection: RTCPeerConnection;
  private pollInterval: NodeJS.Timeout | null = null;
  public stableCount = 0;
  public isDegraded = false;

  private lastStats: {
    timestamp: number;
    packetsLost: number;
    packetsReceived: number;
    framesDecoded: number;
  } | null = null;

  private readonly POLLING_INTERVAL_MS = 2000;
  private readonly STABLE_THRESHOLD_TICKS = 10 / (2000 / 1000); // 10 seconds / 2 seconds = 5 ticks

  constructor(peerConnection: RTCPeerConnection) {
    this.peerConnection = peerConnection;
  }

  start() {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(async () => {
      try {
        await this.checkStats();
      } catch (error) {
        console.error('Error checking stream quality stats:', error);
      }
    }, this.POLLING_INTERVAL_MS);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.lastStats = null;
    this.stableCount = 0;
    this.isDegraded = false;
  }

  public calculateMOS(rttMs: number, jitterMs: number, packetLossRatio: number): number {
    const d = (rttMs / 2) + jitterMs;

    // Id calculation
    const H = (x: number) => x > 0 ? 1 : 0;
    const Id = 0.024 * d + 0.11 * (d - 177.3) * H(d - 177.3);

    // Ie calculation (Equipment Impairment Factor based on packet loss)
    // Common VoIP approximation:
    const Ie = packetLossRatio > 0 ? 30 * Math.log(1 + 15 * packetLossRatio) : 0;

    const R = 93.2 - Id - Ie;

    if (R < 0) return 1.0;

    const mos = 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7 * Math.pow(10, -6);

    if (mos < 1.0) return 1.0;
    if (mos > 5.0) return 5.0;

    return mos;
  }

  public async checkStats() {
    // Only proceed if the connection is still alive
    if (this.peerConnection.signalingState === 'closed') {
      this.stop();
      return;
    }

    let stats: RTCStatsReport;
    try {
      stats = await this.peerConnection.getStats();
    } catch (err) {
      return;
    }

    let roundTripTime = 0;
    let jitter = 0;

    let currentOutboundPacketsLost = 0;
    let currentOutboundPacketsSent = 0;

    let currentInboundPacketsLost = 0;
    let currentInboundPacketsReceived = 0;

    let currentFramesDecoded = 0;
    let timestamp = Date.now();

    stats.forEach((report) => {
      // Evaluate outbound path (what the remote peer receives from us)
      if (report.type === 'remote-inbound-rtp') {
        currentOutboundPacketsLost += report.packetsLost || 0;
        jitter = Math.max(jitter, report.jitter ? report.jitter * 1000 : 0);
        roundTripTime = (report.roundTripTime || 0) * 1000;
      }

      if (report.type === 'outbound-rtp') {
        currentOutboundPacketsSent += report.packetsSent || 0;
      }

      // Evaluate inbound path (what we receive from the remote peer)
      if (report.type === 'inbound-rtp') {
        currentInboundPacketsReceived += report.packetsReceived || 0;
        currentInboundPacketsLost += report.packetsLost || 0;

        if (report.kind === 'video') {
          currentFramesDecoded = report.framesDecoded || 0;
          jitter = Math.max(jitter, report.jitter ? report.jitter * 1000 : 0);
        } else if (report.kind === 'audio') {
          jitter = Math.max(jitter, report.jitter ? report.jitter * 1000 : 0);
        }
      }

      if (report.type === 'candidate-pair' && report.state === 'succeeded' && roundTripTime === 0) {
        const rtt = report.currentRoundTripTime || report.roundTripTime || 0;
        roundTripTime = rtt * 1000;
      }
    });

    const currentPacketsLost = currentOutboundPacketsLost + currentInboundPacketsLost;
    const currentPacketsTotal = currentOutboundPacketsSent + currentOutboundPacketsLost + currentInboundPacketsReceived + currentInboundPacketsLost;

    if (!this.lastStats) {
      this.lastStats = {
        timestamp,
        packetsLost: currentPacketsLost,
        packetsReceived: currentPacketsTotal, // storing total as received to reuse property name without refactoring much
        framesDecoded: currentFramesDecoded,
      };
      return;
    }

    const packetsLostDiff = Math.max(0, currentPacketsLost - this.lastStats.packetsLost);
    const packetsTotalDiff = Math.max(0, currentPacketsTotal - this.lastStats.packetsReceived);

    const packetLossRatio = packetsTotalDiff > 0 ? packetsLostDiff / packetsTotalDiff : 0;

    const mos = this.calculateMOS(roundTripTime, jitter, packetLossRatio);

    if (mos < 3.0 || packetLossRatio > 0.06) {
      this.stableCount = 0;
      if (!this.isDegraded) {
        await this.degradeStream();
      }
    } else {
      if (this.isDegraded) {
        this.stableCount++;
        if (this.stableCount >= this.STABLE_THRESHOLD_TICKS) {
          await this.restoreStream();
        }
      }
    }

    this.lastStats = {
      timestamp,
      packetsLost: currentPacketsLost,
      packetsReceived: currentPacketsTotal,
      framesDecoded: currentFramesDecoded,
    };
  }

  private async degradeStream() {
    this.isDegraded = true;
    const senders = this.peerConnection.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) {
          params.encodings = [{}];
        }
        if (params.encodings.length > 0) {
            params.encodings[0].scaleResolutionDownBy = 2.0;
            params.encodings[0].maxBitrate = 250000; // 250 kbps
            try {
              await sender.setParameters(params);
            } catch (error) {
              console.error('Error setting parameters during degradation', error);
            }
        }
      }
    }
  }

  private async restoreStream() {
    this.isDegraded = false;
    this.stableCount = 0;
    const senders = this.peerConnection.getSenders();
    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].scaleResolutionDownBy = 1.0;
          // Reconstruct encoding without maxBitrate properly to avoid delete operator issues
          const newEncoding = { ...params.encodings[0] };
          delete newEncoding.maxBitrate;
          params.encodings[0] = newEncoding;
          try {
            await sender.setParameters(params);
          } catch (error) {
            console.error('Error setting parameters during restoration', error);
          }
        }
      }
    }
  }
}
