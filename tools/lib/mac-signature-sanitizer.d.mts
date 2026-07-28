export function shouldRemoveMacCodeSignatures(
  platform: string,
  requestedArchitecture: string,
  packagedArchitecture: string,
): boolean;

export function removeMacCodeSignatures(
  root: string,
  platform: string,
): Promise<void>;
