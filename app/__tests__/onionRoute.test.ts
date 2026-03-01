/**
 * Unit tests for onionRoute utilities.
 * These run against the JS stubs (no native module needed).
 */

import { parseRelayRecord, hopFromRecord } from '../src/utils/onionRoute';

describe('parseRelayRecord', () => {
  it('extracts hop URL and pubkey from a relay PkarrResolved', () => {
    const record = {
      recordType: 'relay',
      name: 'https://relay.delta.app/hop',
      avatarBlobId: 'ab'.repeat(32),
      username: null,
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'somez32key',
    };
    const hop = parseRelayRecord(record);
    expect(hop).toEqual({
      pubkeyHex: 'ab'.repeat(32),
      nextUrl: 'https://relay.delta.app/hop',
    });
  });

  it('returns null for non-relay records', () => {
    const record = {
      recordType: 'user',
      name: null,
      avatarBlobId: null,
      username: 'alice',
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'somez32key',
    };
    expect(parseRelayRecord(record)).toBeNull();
  });

  it('returns null when name or avatarBlobId is missing', () => {
    const record = {
      recordType: 'relay',
      name: null,
      avatarBlobId: null,
      username: null,
      description: null,
      bio: null,
      coverBlobId: null,
      publicKey: 'key',
    };
    expect(parseRelayRecord(record)).toBeNull();
  });
});
