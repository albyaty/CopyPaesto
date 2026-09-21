const STALE_FILE_SYSTEM_MESSAGE = /state cached in an interface object|state had changed since it was read from disk/i;

export function describeFileSystemError(
  cause: unknown,
  fallback: string,
  operation: "open" | "write" | "commit" = "write",
) {
  const name = cause instanceof DOMException ? cause.name : "";
  const message = cause instanceof Error ? cause.message : "";

  if (name === "QuotaExceededError") {
    return "The save drive does not have enough free space for this file. Free some space or choose another folder, then resend it.";
  }
  if (name === "InvalidStateError" || STALE_FILE_SYSTEM_MESSAGE.test(message)) {
    if (operation === "commit") {
      return "All bytes arrived, but Windows could not finish saving the file. Check free disk space and choose the folder again. If it is on OneDrive or a network drive, try a local folder, then resend the file.";
    }
    return "The save folder changed or became unavailable. Check free disk space, choose the folder again, then resend the file.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Chrome or Edge lost permission to the save folder. Choose the folder again, then resend the file.";
  }
  if (name === "NotFoundError") {
    return "The save folder is no longer available. Choose another folder, then resend the file.";
  }
  if (name === "NoModificationAllowedError") {
    return "The selected save folder is read-only. Choose a writable folder, then resend the file.";
  }
  if (name === "NetworkError") {
    return "The save folder went offline while the file was being written. Reconnect the drive or choose a local folder, then resend the file.";
  }
  return message || fallback;
}
