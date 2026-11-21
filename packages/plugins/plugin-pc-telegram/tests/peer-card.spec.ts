import { describe, expect, it } from "vitest";
import {
  expandStrippedThumb,
  hasProfilePhoto,
  inlineProfilePhoto,
  photoDataUrl,
  rememberProfilePhoto,
  remainingPhotoBudget,
} from "../src/peer-card.js";

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0]);

describe("profile photo cache", () => {
  it("rejects a tiny or oversized blob without treating that as a stored avatar", () => {
    expect(photoDataUrl(jpeg.slice(0, 8), 80_000)).toBeNull();
    expect(photoDataUrl(jpeg, 16)).toBeNull();
    const missed = rememberProfilePhoto(undefined, { downloaded: null, fallback: null, knownEmpty: false });
    expect(missed.photo).toBeNull();
    expect(missed.memory.ready).toBe(false);
    const again = rememberProfilePhoto(missed.memory, { downloaded: "data:image/jpeg;base64,abc", fallback: null, knownEmpty: false });
    expect(again.photo).toBe("data:image/jpeg;base64,abc");
    expect(again.memory.ready).toBe(true);
  });

  it("keeps a downloaded avatar when the next download fails", () => {
    const stored = rememberProfilePhoto(undefined, { downloaded: "data:image/jpeg;base64,abc", fallback: null, knownEmpty: false });
    const failed = rememberProfilePhoto(stored.memory, { downloaded: null, fallback: null, knownEmpty: false });
    expect(failed.photo).toBe("data:image/jpeg;base64,abc");
    expect(failed.memory.ready).toBe(true);
  });

  it("keeps a stripped thumb when the file download returns nothing", () => {
    const thumb = rememberProfilePhoto(undefined, { downloaded: null, fallback: "data:image/jpeg;base64,thumb", knownEmpty: false });
    expect(thumb.memory.ready).toBe(false);
    expect(thumb.photo).toBe("data:image/jpeg;base64,thumb");
    const upgraded = rememberProfilePhoto(thumb.memory, { downloaded: "data:image/jpeg;base64,full", fallback: null, knownEmpty: false });
    expect(upgraded.photo).toBe("data:image/jpeg;base64,full");
  });

  it("remembers a dialog with no photo as empty", () => {
    const empty = rememberProfilePhoto(undefined, { downloaded: null, fallback: null, knownEmpty: true });
    expect(empty.photo).toBeNull();
    expect(empty.memory.ready).toBe(true);
    const later = rememberProfilePhoto(empty.memory, { downloaded: "data:image/jpeg;base64,abc", fallback: null, knownEmpty: false });
    expect(later.photo).toBeNull();
  });

  it("does not spend a download slot when the file comes back empty", () => {
    expect(remainingPhotoBudget(24, null, false)).toBe(24);
    expect(remainingPhotoBudget(24, "data:image/jpeg;base64,abc", true)).toBe(23);
    expect(remainingPhotoBudget(0, "data:image/jpeg;base64,abc", true)).toBe(0);
  });

  it("recognizes profile photos beyond the two original class names", () => {
    expect(hasProfilePhoto({ photo: { className: "UserProfilePhoto" } })).toBe(true);
    expect(hasProfilePhoto({ photo: { className: "ChatPhoto" } })).toBe(true);
    expect(hasProfilePhoto({ photo: { className: "Photo", id: 15n } })).toBe(true);
    expect(hasProfilePhoto({ photo: { className: "Api.UserProfilePhoto" } })).toBe(true);
    expect(hasProfilePhoto({ photo: { className: "UserProfilePhotoEmpty" } })).toBe(false);
    expect(hasProfilePhoto({ photo: { className: "ChatPhotoEmpty" } })).toBe(false);
    expect(hasProfilePhoto({ photo: { strippedThumb: Uint8Array.from([1, 8, 8, 9]) } })).toBe(true);
    expect(hasProfilePhoto({})).toBe(false);
    expect(hasProfilePhoto({ photo: null })).toBe(false);
  });

  it("turns a stripped thumb into a jpeg data url", () => {
    const stripped = Uint8Array.from([1, 0x10, 0x10, 4, 5, 6, 7]);
    const bytes = expandStrippedThumb(stripped);
    expect(bytes?.[0]).toBe(0xff);
    expect(bytes?.[1]).toBe(0xd8);
    expect(photoDataUrl(bytes, 80_000)?.startsWith("data:image/jpeg;base64,")).toBe(true);
    const url = inlineProfilePhoto({ photo: { className: "UserProfilePhoto", strippedThumb: stripped } });
    expect(url?.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(inlineProfilePhoto({ photo: { className: "UserProfilePhotoEmpty" } })).toBeNull();
  });
});
