export const SUPPORTED_CONFIG_FILENAMES = [
  "distributor.config.json",
  "distributor.config.js",
  "distributor.config.ts",
] as const;

export type SupportedConfigFilename =
  (typeof SUPPORTED_CONFIG_FILENAMES)[number];
