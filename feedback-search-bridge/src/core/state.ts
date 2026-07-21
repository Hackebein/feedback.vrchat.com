import { STORAGE_KEYS } from "./config";
import type { BridgeSettings, BridgeStorage } from "./types";

export async function writeBridgeSettings(
  storage: BridgeStorage,
  settings: BridgeSettings,
): Promise<void> {
  await storage.set(STORAGE_KEYS.luceneMode, settings.luceneMode);
}
