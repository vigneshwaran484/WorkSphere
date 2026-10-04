import { StreamQualityMonitor } from '../../../src/lib/webrtc/streamQualityMonitor';

describe('StreamQualityMonitor', () => {
  let mockPeerConnection: any;
  let monitor: StreamQualityMonitor;
  let setParametersMock: jest.Mock;

  beforeEach(() => {
    setParametersMock = jest.fn();
    mockPeerConnection = {
      getStats: jest.fn(),
      getSenders: jest.fn().mockReturnValue([
        {
          track: { kind: 'video' },
          getParameters: jest.fn().mockReturnValue({ encodings: [{}] }),
          setParameters: setParametersMock,
        },
        {
          track: { kind: 'audio' },
          getParameters: jest.fn().mockReturnValue({ encodings: [{}] }),
          setParameters: jest.fn(),
        }
      ]),
    };
    monitor = new StreamQualityMonitor(mockPeerConnection as unknown as RTCPeerConnection);
  });

  afterEach(() => {
    monitor.stop();
    jest.clearAllMocks();
  });

  it('should parse stats correctly', async () => {
    const timestamp1 = Date.now() - 2000;
    const timestamp2 = Date.now();

    // First call sets lastStats
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 10, roundTripTime: 0.1, jitter: 0.05 }]
    ]));

    await monitor.checkStats();

    // Check internal state (could be verified by lack of degradation since loss is low)
    expect(monitor.isDegraded).toBe(false);
  });

  it('should correctly calculate MOS', () => {
    // Perfect conditions
    const perfectMos = monitor.calculateMOS(10, 0, 0);
    expect(perfectMos).toBeGreaterThan(4.0);

    // Bad conditions (high latency, high jitter, high packet loss)
    const badMos = monitor.calculateMOS(500, 100, 0.1);
    expect(badMos).toBeLessThan(3.0);
  });

  it('should trigger degradation on high packet loss', async () => {
    // First poll
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.05, jitter: 0 }],
      ['2', { type: 'outbound-rtp', packetsSent: 100 }]
    ]));
    await monitor.checkStats();

    // Second poll with 10% packet loss (10 lost, 90 received basically) -> actually 10 lost, 100 sent
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 10, roundTripTime: 0.05, jitter: 0 }],
      ['2', { type: 'outbound-rtp', packetsSent: 200 }]
    ]));
    await monitor.checkStats();

    expect(monitor.isDegraded).toBe(true);
    expect(setParametersMock).toHaveBeenCalledWith({
      encodings: [{
        scaleResolutionDownBy: 2.0,
        maxBitrate: 250000
      }]
    });
  });

  it('should trigger degradation on low MOS', async () => {
    // First poll
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.0, jitter: 0 }],
      ['2', { type: 'outbound-rtp', packetsSent: 100 }]
    ]));
    await monitor.checkStats();

    // Second poll with 800ms RTT and 200ms jitter (should yield MOS < 3.0)
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.8, jitter: 0.2 }],
      ['2', { type: 'outbound-rtp', packetsSent: 200 }]
    ]));
    await monitor.checkStats();

    expect(monitor.isDegraded).toBe(true);
  });

  it('should recover when conditions are stable for threshold', async () => {
    // Make it degraded first
    monitor.isDegraded = true;

    // Mock perfect stats
    mockPeerConnection.getStats.mockResolvedValue(new Map([
      ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.0, jitter: 0 }],
      ['2', { type: 'outbound-rtp', packetsSent: 100 }]
    ]));

    // First call sets lastStats
    await monitor.checkStats();

    // Call checkStats STABLE_THRESHOLD_TICKS times (5)
    for (let i = 0; i < 4; i++) {
      mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
        ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.0, jitter: 0 }],
        ['2', { type: 'outbound-rtp', packetsSent: 100 + (i+1)*100 }]
      ]));
      await monitor.checkStats();
    }

    expect(monitor.isDegraded).toBe(true);

    // 5th time should restore
    mockPeerConnection.getStats.mockResolvedValueOnce(new Map([
        ['1', { type: 'remote-inbound-rtp', packetsLost: 0, roundTripTime: 0.0, jitter: 0 }],
        ['2', { type: 'outbound-rtp', packetsSent: 600 }]
    ]));
    await monitor.checkStats();

    expect(monitor.isDegraded).toBe(false);
    expect(monitor.stableCount).toBe(0);
    expect(setParametersMock).toHaveBeenCalledWith({
      encodings: [{
        scaleResolutionDownBy: 1.0
      }]
    });
  });
});
