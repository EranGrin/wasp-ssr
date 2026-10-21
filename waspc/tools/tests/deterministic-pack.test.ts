import { gunzipSync } from "fflate";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deterministicGzip,
  normalizePackedTarball,
  normalizeTarModes,
} from "../libs/deterministic-pack.ts";

const digest = (bytes: Uint8Array) =>
  createHash("sha512").update(bytes).digest("base64");

test("fixed-input gzip bytes have a cross-runtime golden SHA512 and fixed header", () => {
  const input = new TextEncoder().encode(
    "Wasp deterministic gzip fixture v1\n",
  );
  const bytes = deterministicGzip(input);
  assert.equal(
    digest(bytes),
    "0qvKIPZoFVLh57St37ZOfeBTmRMF/xXiFAeLCpfhOAYsNqC7eZVB1qUmu7MFlHtUztPosYHA7xESTW3+uRQW7g==",
  );
  assert.deepEqual(
    [...bytes.subarray(0, 10)],
    [31, 139, 8, 0, 0, 0, 0, 0, 2, 255],
  );
  assert.deepEqual(gunzipSync(bytes), input);
});

test("packing a fixture twice ignores local executable permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "wasp-pack-"));
  try {
    const pkg = join(root, "package");
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "wasp-deterministic-fixture",
        version: "1.0.0",
        files: ["README.md", "payload.txt"],
      }),
    );
    writeFileSync(join(pkg, "README.md"), "# Fixed fixture\n");
    writeFileSync(join(pkg, "payload.txt"), "fixed contents\n");
    const pack = (mode: number, destination: string) => {
      mkdirSync(destination);
      for (const file of ["package.json", "README.md", "payload.txt"])
        chmodSync(join(pkg, file), mode);
      const output = JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--offline",
            "--pack-destination",
            destination,
          ],
          { cwd: pkg, encoding: "utf8" },
        ),
      );
      const path = join(destination, output[0].filename);
      normalizePackedTarball(path);
      return readFileSync(path);
    };
    const first = pack(0o700, join(root, "first"));
    const second = pack(0o644, join(root, "second"));
    assert.deepEqual(first, second);
    assert.deepEqual(
      Buffer.from(normalizeTarModes(gunzipSync(first))),
      Buffer.from(gunzipSync(first)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes directory headers and checksum without changing input", () => {
  const tar = Buffer.alloc(1536);
  tar.write("package/");
  tar.write("0000700\0", 100);
  tar.write("00000000000\0", 124);
  tar[156] = 53;
  const before = Buffer.from(tar);
  const result = Buffer.from(normalizeTarModes(tar));
  assert.deepEqual(tar, before);
  assert.equal(result.subarray(100, 108).toString(), "0000755\0");
  const checksum = Number.parseInt(result.subarray(148, 154).toString(), 8);
  const header = Buffer.from(result.subarray(0, 512));
  header.fill(32, 148, 156);
  assert.equal(
    checksum,
    header.reduce((sum, byte) => sum + byte, 0),
  );
});

test("refuses a truncated tar instead of producing a plausible archive", () => {
  assert.throws(() => normalizeTarModes(new Uint8Array(1)), /end marker/);
  const tar = Buffer.alloc(512);
  tar.write("package/payload");
  tar.write("00000002000\0", 124);
  assert.throws(() => normalizeTarModes(tar), /Truncated/);
});
