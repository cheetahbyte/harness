import manifest from "../../../package.json" with { type: "json" };

/**
 * The version the running build was compiled from. `bun build --compile` inlines
 * the manifest, so the binary reports the version its release was tagged with
 * rather than whatever package.json happens to sit next to it at runtime.
 */
export const VERSION: string = manifest.version;
