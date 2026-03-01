import { describe, it, expect } from 'vitest';
import { buildRelayTxtRecord, parseRelayTxtRecord } from './pkarr';

describe('buildRelayTxtRecord', () => {
  it('produces the correct format', () => {
    const record = buildRelayTxtRecord(
      'aabbcc00'.repeat(8),         // 64-char pubkey hex
      'https://relay.delta.app/hop',
    );
    expect(record).toBe(
      'v=delta1;t=relay;n=https://relay.delta.app/hop;a=aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00aabbcc00',
    );
  });
});

describe('parseRelayTxtRecord', () => {
  it('round-trips', () => {
    const pubkeyHex = 'aabbcc00'.repeat(8);
    const hopUrl    = 'https://relay.delta.app/hop';
    const record    = buildRelayTxtRecord(pubkeyHex, hopUrl);
    const parsed    = parseRelayTxtRecord(record);
    expect(parsed).toEqual({ pubkeyHex, hopUrl });
  });

  it('returns null for non-relay records', () => {
    expect(parseRelayTxtRecord('v=delta1;t=user;u=alice')).toBeNull();
  });
});
