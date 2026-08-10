import type { QueuedMutation } from "./db";

export type QueuedMediaRegistrationIdentity = {
  fingerprint: string;
  renditionKey: string;
};

/** Legacy queued rows predate rendition keys and always describe source MP3 bytes. */
const queuedRenditionKey = (mutation: QueuedMutation) =>
  typeof mutation.payload.renditionKey === "string" ? mutation.payload.renditionKey : "source-v1";

export function queuedMediaRegistrationIdentity(
  mutation: QueuedMutation,
): QueuedMediaRegistrationIdentity | null {
  if (mutation.kind === "import") {
    const fingerprint =
      typeof mutation.payload.fingerprint === "string"
        ? mutation.payload.fingerprint
        : mutation.entityId;
    return fingerprint ? { fingerprint, renditionKey: queuedRenditionKey(mutation) } : null;
  }
  if (mutation.kind !== "delete" || typeof mutation.payload.fingerprint !== "string") return null;
  return {
    fingerprint: mutation.payload.fingerprint,
    renditionKey: queuedRenditionKey(mutation),
  };
}

export function sameQueuedMediaRegistration(
  left: QueuedMediaRegistrationIdentity | null,
  right: QueuedMediaRegistrationIdentity | null,
): boolean {
  return !!(
    left &&
    right &&
    left.fingerprint === right.fingerprint &&
    left.renditionKey === right.renditionKey
  );
}
