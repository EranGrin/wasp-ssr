/// <reference types="node" />
import { gunzipSync, gzipSync } from "fflate";
import { readFileSync, writeFileSync } from "node:fs";

/** Fixed JS compressor and gzip metadata: independent of Node's linked zlib. */
export function deterministicGzip(input: Uint8Array): Uint8Array {
  const gzip = gzipSync(input, { level: 9, mtime: 0 });
  // ID1/ID2, deflate, no optional fields, mtime=0, max compression, OS unknown.
  gzip.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255], 0);
  return gzip;
}

/** npm supplies stable tar ordering/metadata; remove local permission bits too. */
export function normalizeTarModes(input: Uint8Array): Uint8Array {
  const tar = Buffer.from(input);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Non-zero data after tar end marker");
      return tar;
    }
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    if (!/^[0-7]+$/.test(sizeText))
      throw new Error("Unsupported tar size encoding");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid tar entry size");
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error("Truncated tar entry");
    // npm pack has regular files and optional directory headers. Never inherit
    // executable/setuid/setgid bits from the developer's filesystem.
    header.write(
      header[156] === 53 ? "0000755\0" : "0000644\0",
      100,
      8,
      "ascii",
    );
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      checksum.toString(8).padStart(6, "0") + "\0 ",
      148,
      8,
      "ascii",
    );
    offset = next;
  }
  throw new Error("Missing tar end marker");
}

export function normalizePackedTarball(path: string): void {
  const tar = normalizeTarModes(gunzipSync(readFileSync(path)));
  writeFileSync(path, deterministicGzip(tar));
}
