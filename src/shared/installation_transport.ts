/** A maximum C4 state with three-byte error characters fits below this bound. */
export const INSTALLATION_TRANSFER = {
  bytes: 512 * 1024,
  characters: 16 * 1024,
  pending: 17, // 16 client RPC slots plus the latest pushed state.
} as const;
