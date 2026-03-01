import { describe, it, expect } from 'vitest';
import { buildTestPacket, peelLayer } from './onion';
import { bytesToHex } from './crypto';

describe('peelLayer', () => {
  it('decrypts a Forward payload', async () => {
    const { packet, seedHex, expectedNextUrl, expectedInner } =
      await buildTestPacket('forward');
    const result = peelLayer(packet, seedHex);
    expect(result.type).toBe('forward');
    if (result.type !== 'forward') throw new Error();
    expect(result.nextHopUrl).toBe(expectedNextUrl);
    expect(result.innerPacket).toEqual(expectedInner);
  });

  it('decrypts a Deliver payload', async () => {
    const { packet, seedHex, expectedTopicId, expectedOp } =
      await buildTestPacket('deliver');
    const result = peelLayer(packet, seedHex);
    expect(result.type).toBe('deliver');
    if (result.type !== 'deliver') throw new Error();
    expect(result.topicId).toEqual(expectedTopicId);
    expect(result.op).toEqual(expectedOp);
  });

  it('throws on wrong seed', async () => {
    const { packet } = await buildTestPacket('forward');
    const wrongSeed = new Uint8Array(32).fill(0xff);
    expect(() => peelLayer(packet, bytesToHex(wrongSeed))).toThrow();
  });

  it('throws on tampered envelope', async () => {
    const { packet, seedHex } = await buildTestPacket('forward');
    packet[packet.length - 1] ^= 0xff;
    expect(() => peelLayer(packet, seedHex)).toThrow();
  });

  it('throws on too-short envelope', () => {
    expect(() => peelLayer(new Uint8Array(10), 'a'.repeat(64))).toThrow();
  });
});
