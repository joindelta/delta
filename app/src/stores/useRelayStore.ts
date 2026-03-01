/**
 * Relay store — maintains the ordered list of known relay hops.
 *
 * Usage:
 *   const { hops, refresh } = useRelayStore();
 *   await sendOnionMessage(hops, destNodeId, bytes);
 */

import { create } from 'zustand';
import { resolveRelayHops } from '../utils/onionRoute';
import type { OnionHopFfi } from '../ffi/deltaCore';

/**
 * Hardcoded list of relay pkarr z32 keys for the Delta-operated relays.
 * Update this list when new relay Workers are deployed.
 * Format: z32-encoded Ed25519 public key (the pkarr address of the relay).
 */
export const KNOWN_RELAY_PKARR_KEYS: string[] = [
  // Add relay z32 keys here once Workers are deployed
];

interface RelayState {
  hops: OnionHopFfi[];
  loading: boolean;
  /** Re-resolve all KNOWN_RELAY_PKARR_KEYS from the DHT. */
  refresh(): Promise<void>;
}

export const useRelayStore = create<RelayState>((set) => ({
  hops: [],
  loading: false,

  async refresh() {
    set({ loading: true });
    try {
      const hops = await resolveRelayHops(KNOWN_RELAY_PKARR_KEYS);
      set({ hops });
    } finally {
      set({ loading: false });
    }
  },
}));
