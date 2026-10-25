import test from "node:test";
import assert from "node:assert/strict";

import {
  ERASE_CONFIRM_WORD,
  FLASH_CONFIG_VERSION,
  MAX_CONFIG_JSON_BYTES,
  MAX_CONFIG_ROWS,
  MAX_CONFIG_STRING_LENGTH,
  MAX_MERGED_IMAGE_BYTES,
  buildMergedFlashImage,
  canConfirmErase,
  createDefaultFlashConfig,
  formatFlashAddress,
  parseFlashAddress,
  parseFlashConfigImport,
  planFlashEntries,
  sanitizeFlashConfig,
  serializeFlashConfig,
} from "../renderer/upstream/esp-flash-core.mjs";

test("default flash config matches the approved seven-segment layout", () => {
  assert.deepEqual(createDefaultFlashConfig(), {
    version: FLASH_CONFIG_VERSION,
    rows: [
      { enabled: true, label: "bootloader.bin", address: "0x0" },
      { enabled: true, label: "partition-table.bin", address: "0x8000" },
      { enabled: true, label: "ota_data_initial.bin", address: "0x10000" },
      { enabled: true, label: "play_http_mp3.bin", address: "0x20000" },
      { enabled: true, label: "srmodels.bin", address: "0x750000" },
      { enabled: true, label: "storage.bin", address: "0xa50000" },
      { enabled: true, label: "backup.bin", address: "0xd50000" },
    ],
    mergedFilename: "merged.bin",
    baudRate: 115200,
    flashMode: "dio",
    flashFreq: "40m",
    flashSize: "16MB",
    compress: true,
    resetAfterWrite: true,
  });
});


test("parseFlashAddress accepts decimal, hex, and numeric input", () => {
  assert.equal(parseFlashAddress("0"), 0);
  assert.equal(parseFlashAddress("4096"), 4096);
  assert.equal(parseFlashAddress("0x1000"), 4096);
  assert.equal(parseFlashAddress("0X8000"), 0x8000);
  assert.equal(parseFlashAddress(0x10000), 0x10000);
  assert.equal(formatFlashAddress("4096"), "0x1000");
});

test("parseFlashAddress rejects blanks, negatives, floats, invalid strings, and unsafe integers", () => {
  for (const value of ["", " ", "-1", "1.5", "abc", "0x", "0x1.2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseFlashAddress(value), /地址/);
  }
});

test("planFlashEntries validates enabled BIN rows, ignores disabled rows, and sorts by address", () => {
  const planned = planFlashEntries([
    {
      enabled: false,
      name: "skip.txt",
      address: "0x0",
      bytes: new Uint8Array([]),
    },
    {
      enabled: true,
      name: "app.bin",
      address: "0x10000",
      bytes: Uint8Array.from([0xaa, 0xbb]),
    },
    {
      enabled: true,
      filename: "bootloader.bin",
      address: "4096",
      bytes: Uint8Array.from([0x01]),
    },
  ]);

  assert.deepEqual(
    planned.map((entry) => ({
      name: entry.name,
      address: entry.address,
      start: entry.start,
      end: entry.end,
      size: entry.size,
    })),
    [
      { name: "bootloader.bin", address: 4096, start: 4096, end: 4097, size: 1 },
      { name: "app.bin", address: 0x10000, start: 0x10000, end: 0x10002, size: 2 },
    ],
  );
});

test("planFlashEntries rejects missing enabled files, non-bin names, empty bytes, overlaps, and non-binary payloads", () => {
  assert.throws(() => planFlashEntries([]), /至少需要一个已启用/);
  assert.throws(
    () => planFlashEntries([{ enabled: true, name: "firmware.txt", address: "0x0", bytes: Uint8Array.from([1]) }]),
    /\.bin 文件/,
  );
  assert.throws(
    () => planFlashEntries([{ enabled: true, name: "firmware.bin", address: "0x0", bytes: new Uint8Array([]) }]),
    /不能为空/,
  );
  assert.throws(
    () => planFlashEntries([{ enabled: true, name: "firmware.bin", address: "0x0", bytes: "abc" }]),
    /二进制字节/,
  );
  assert.throws(
    () => planFlashEntries([
      { enabled: true, name: "a.bin", address: "0x1000", bytes: Uint8Array.from([1, 2]) },
      { enabled: true, name: "b.bin", address: "0x1001", bytes: Uint8Array.from([3, 4]) },
    ]),
    /重叠/,
  );
});

test("buildMergedFlashImage fills holes with 0xFF and preserves source bytes at offsets", () => {
  const merged = buildMergedFlashImage([
    {
      enabled: true,
      name: "bootloader.bin",
      address: "0x0",
      bytes: Uint8Array.from([0x11, 0x22]),
    },
    {
      enabled: true,
      name: "app.bin",
      address: "0x4",
      bytes: Uint8Array.from([0xaa, 0xbb, 0xcc]),
    },
  ]);

  assert.equal(merged.size, 7);
  assert.deepEqual([...merged.image], [0x11, 0x22, 0xff, 0xff, 0xaa, 0xbb, 0xcc]);
  assert.deepEqual(merged.segments, [
    { name: "bootloader.bin", address: 0, size: 2, start: 0, end: 2 },
    { name: "app.bin", address: 4, size: 3, start: 4, end: 7 },
  ]);
});

test("buildMergedFlashImage rejects sparse output larger than 64 MiB", () => {
  assert.throws(
    () => buildMergedFlashImage([
      {
        enabled: true,
        name: "too-large.bin",
        address: formatFlashAddress(MAX_MERGED_IMAGE_BYTES),
        bytes: Uint8Array.from([1]),
      },
    ]),
    /64 MiB/,
  );
});

test("sanitizeFlashConfig normalizes known fields and drops unknown fields", () => {
  const sanitized = sanitizeFlashConfig({
    version: 999,
    rows: [
      {
        enabled: 1,
        label: " Boot ",
        address: "4096",
        unknown: "ignored",
      },
      {
        enabled: 0,
        name: " App ",
        address: "0x10000",
      },
    ],
    mergedFilename: " merged.bin ",
    baudRate: 921600,
    flashMode: "dio",
    flashFreq: "40m",
    flashSize: "keep",
    compress: 1,
    resetAfterWrite: 0,
    surprise: "ignored",
  });

  assert.deepEqual(sanitized, {
    version: FLASH_CONFIG_VERSION,
    rows: [
      { enabled: true, label: "Boot", address: "0x1000" },
      { enabled: false, label: "App", address: "0x10000" },
    ],
    mergedFilename: "merged.bin",
    baudRate: 921600,
    flashMode: "dio",
    flashFreq: "40m",
    flashSize: "keep",
    compress: true,
    resetAfterWrite: false,
  });

  const serialized = serializeFlashConfig({
    rows: [{ enabled: true, label: "Boot", address: "0x1000" }],
    mergedFilename: "firmware.bin",
    baudRate: 115200,
    flashMode: "qio",
    flashFreq: "80m",
    flashSize: "4MB",
    compress: false,
    resetAfterWrite: true,
  });
  assert.equal(serialized.includes('"bytes"'), false);
  assert.equal(serialized.includes('"file"'), false);
});

test("config import rejects invalid roots, unsupported versions, dangerous keys, firmware bytes, and oversize payloads", () => {
  for (const invalid of ["[]", "null", '"value"']) {
    assert.throws(() => parseFlashConfigImport(invalid), /根节点必须是对象/);
  }

  assert.throws(
    () => parseFlashConfigImport(JSON.stringify({ version: 2, rows: [] })),
    /仅支持版本/,
  );
  assert.throws(
    () => parseFlashConfigImport('{"version":1,"rows":[{"__proto__":{"polluted":true}}]}'),
    /不安全字段/,
  );
  assert.throws(
    () => parseFlashConfigImport(JSON.stringify({
      version: 1,
      rows: [{ enabled: true, label: "Boot", address: "0x1000", bytes: [1, 2, 3] }],
    })),
    /固件或本地文件字段/,
  );
  assert.throws(
    () => parseFlashConfigImport(`{"version":1,"rows":[],"mergedFilename":"${"x".repeat(MAX_CONFIG_JSON_BYTES)}"}`),
    /不能超过/,
  );
});

test("config import enforces row and string bounds and preserves normalized values", () => {
  const rows = Array.from({ length: MAX_CONFIG_ROWS }, (_, index) => ({
    enabled: index % 2 === 0,
    label: `Row ${index}`,
    address: index,
    extra: "ignored",
  }));

  const parsed = parseFlashConfigImport(JSON.stringify({
    version: "1",
    rows,
    mergedFilename: " release.bin ",
    baudRate: 460800,
    flashMode: "dio",
    flashFreq: "80m",
    flashSize: "8MB",
    compress: true,
    resetAfterWrite: true,
    extraTopLevel: "ignored",
  }));

  assert.equal(parsed.rows.length, MAX_CONFIG_ROWS);
  assert.deepEqual(parsed.rows[0], { enabled: true, label: "Row 0", address: "0x0" });
  assert.deepEqual(parsed.rows.at(-1), {
    enabled: false,
    label: `Row ${MAX_CONFIG_ROWS - 1}`,
    address: formatFlashAddress(MAX_CONFIG_ROWS - 1),
  });
  assert.equal(parsed.mergedFilename, "release.bin");

  for (const [field, value] of [
    ["flashMode", "auto"],
    ["flashFreq", "160m"],
    ["flashSize", "detect"],
  ]) {
    assert.throws(
      () => parseFlashConfigImport(JSON.stringify({ version: 1, rows: [], [field]: value })),
      /不是支持的选项/,
    );
  }

  assert.throws(
    () => parseFlashConfigImport(JSON.stringify({
      version: 1,
      rows: Array.from({ length: MAX_CONFIG_ROWS + 1 }, () => ({
        enabled: true,
        label: "Boot",
        address: "0x0",
      })),
    })),
    /rows 不能超过/,
  );
  assert.throws(
    () => parseFlashConfigImport(JSON.stringify({
      version: 1,
      rows: [{
        enabled: true,
        label: "x".repeat(MAX_CONFIG_STRING_LENGTH + 1),
        address: "0x0",
      }],
    })),
    /固件行名称不能超过/,
  );
});

test("canConfirmErase requires connected state, exact confirmation word, and explicit second confirmation", () => {
  assert.equal(
    canConfirmErase({
      isConnected: true,
      confirmationText: ERASE_CONFIRM_WORD,
      isSecondConfirmation: true,
    }),
    true,
  );
  assert.equal(
    canConfirmErase({
      isConnected: true,
      confirmationText: "erase",
      isSecondConfirmation: true,
    }),
    false,
  );
  assert.equal(
    canConfirmErase({
      isConnected: false,
      confirmationText: ERASE_CONFIRM_WORD,
      isSecondConfirmation: true,
    }),
    false,
  );
  assert.equal(
    canConfirmErase({
      isConnected: true,
      confirmationText: ERASE_CONFIRM_WORD,
      isSecondConfirmation: false,
    }),
    false,
  );
});
