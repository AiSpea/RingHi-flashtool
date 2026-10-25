export const MAX_MERGED_IMAGE_BYTES = 64 * 1024 * 1024;
export const FLASH_CONFIG_VERSION = 1;
export const MAX_CONFIG_ROWS = 64;
export const MAX_CONFIG_JSON_BYTES = 64 * 1024;
export const MAX_CONFIG_STRING_LENGTH = 256;
export const ERASE_CONFIRM_WORD = "ERASE";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_CONFIG_KEYS = new Set([
  "arraybuffer",
  "blob",
  "bytes",
  "data",
  "file",
  "filebytes",
  "filehandle",
  "filepath",
  "fullpath",
  "handle",
  "path",
]);
const FLASH_MODES = new Set(["keep", "dio", "qio", "dout", "qout"]);
const FLASH_FREQUENCIES = new Set(["keep", "80m", "40m", "26m", "20m"]);
const FLASH_SIZES = new Set(["keep", "2MB", "4MB", "8MB", "16MB"]);

export function createDefaultFlashConfig() {
  return {
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
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectKeys(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`配置包含不安全字段：${path}.${key}`);
    }
    inspectKeys(child, `${path}.${key}`);
  }
}

function byteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function boundedString(value, label, { max = MAX_CONFIG_STRING_LENGTH, allowEmpty = true } = {}) {
  const normalized = String(value ?? "").trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`${label}不能为空`);
  }
  if (byteLength(normalized) > max) {
    throw new Error(`${label}不能超过 ${max} 字节`);
  }
  return normalized;
}

function positiveSafeInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}必须是 ${min}-${max} 的安全整数`);
  }
  return number;
}

function ensureNoFirmwareLikeKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => ensureNoFirmwareLikeKeys(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.has(String(key).toLowerCase())) {
      throw new Error(`配置不能包含固件或本地文件字段：${path}.${key}`);
    }
    ensureNoFirmwareLikeKeys(child, `${path}.${key}`);
  }
}

function toUint8Array(value, label) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  throw new Error(`${label}必须是二进制字节`);
}

function validateBinName(value, label) {
  const filename = boundedString(value, label, { allowEmpty: false });
  if (!/\.bin$/i.test(filename)) {
    throw new Error(`${label}必须是 .bin 文件`);
  }
  return filename;
}

function validateRangeEnd(address, size, label) {
  const end = address + size;
  if (!Number.isSafeInteger(end)) {
    throw new Error(`${label}超出安全整数范围`);
  }
  if (end > MAX_MERGED_IMAGE_BYTES) {
    throw new Error(`合并结果不能超过 64 MiB`);
  }
  return end;
}

function sanitizeRowLabel(value) {
  return boundedString(value, "固件行名称", { allowEmpty: true });
}

function sanitizeOption(value, label, allowed, fallback) {
  const normalized = boundedString(value ?? fallback, label, { max: 16, allowEmpty: false });
  if (!allowed.has(normalized)) {
    throw new Error(`${label} 不是支持的选项`);
  }
  return normalized;
}

export function parseFlashAddress(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("地址必须是非负安全整数");
    }
    return value;
  }

  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("地址不能为空");
  }

  let parsed;
  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    parsed = Number.parseInt(normalized.slice(2), 16);
  } else if (/^\d+$/.test(normalized)) {
    parsed = Number.parseInt(normalized, 10);
  } else {
    throw new Error("地址必须是十六进制或十进制非负整数");
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("地址必须是非负安全整数");
  }
  return parsed;
}

export function formatFlashAddress(value) {
  return `0x${parseFlashAddress(value).toString(16)}`;
}

export function planFlashEntries(entries, { requireEnabled = true } = {}) {
  if (!Array.isArray(entries)) {
    throw new Error("固件条目必须是数组");
  }

  const enabledEntries = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      if (entry === null || entry === undefined) return;
      throw new Error(`第 ${index + 1} 行固件条目无效`);
    }
    if (!entry.enabled) return;

    const name = validateBinName(entry.name ?? entry.filename, `第 ${index + 1} 行文件名`);
    const address = parseFlashAddress(entry.address);
    const bytes = toUint8Array(entry.bytes, `第 ${index + 1} 行固件`);
    if (bytes.byteLength <= 0) {
      throw new Error(`第 ${index + 1} 行固件不能为空`);
    }
    const end = validateRangeEnd(address, bytes.byteLength, `第 ${index + 1} 行固件区间`);
    enabledEntries.push({
      index,
      enabled: true,
      name,
      address,
      bytes,
      size: bytes.byteLength,
      start: address,
      end,
    });
  });

  if (requireEnabled && enabledEntries.length === 0) {
    throw new Error("至少需要一个已启用的 BIN 文件");
  }

  enabledEntries.sort((left, right) => {
    if (left.address !== right.address) return left.address - right.address;
    return left.index - right.index;
  });

  for (let index = 1; index < enabledEntries.length; index += 1) {
    const previous = enabledEntries[index - 1];
    const current = enabledEntries[index];
    if (current.start < previous.end) {
      throw new Error(
        `${current.name} 与 ${previous.name} 地址区间重叠：${formatFlashAddress(current.start)} < ${formatFlashAddress(previous.end)}`,
      );
    }
  }

  return enabledEntries;
}

export function buildMergedFlashImage(entries) {
  const plannedEntries = planFlashEntries(entries);
  const totalSize = plannedEntries.at(-1)?.end ?? 0;
  if (totalSize > MAX_MERGED_IMAGE_BYTES) {
    throw new Error("合并结果不能超过 64 MiB");
  }

  const image = new Uint8Array(totalSize);
  image.fill(0xFF);
  plannedEntries.forEach((entry) => {
    image.set(entry.bytes, entry.address);
  });

  return {
    image,
    size: image.byteLength,
    segments: plannedEntries.map((entry) => ({
      name: entry.name,
      address: entry.address,
      size: entry.size,
      start: entry.start,
      end: entry.end,
    })),
  };
}

export function sanitizeFlashConfig(config) {
  if (!isPlainObject(config)) {
    throw new Error("配置必须是对象");
  }

  inspectKeys(config);
  ensureNoFirmwareLikeKeys(config);

  const rows = config.rows ?? [];
  if (!Array.isArray(rows)) {
    throw new Error("配置 rows 必须是数组");
  }
  if (rows.length > MAX_CONFIG_ROWS) {
    throw new Error(`配置 rows 不能超过 ${MAX_CONFIG_ROWS} 行`);
  }

  return {
    version: FLASH_CONFIG_VERSION,
    rows: rows.map((row, index) => {
      if (!isPlainObject(row)) {
        throw new Error(`第 ${index + 1} 行配置无效`);
      }
      inspectKeys(row, `$.rows[${index}]`);
      ensureNoFirmwareLikeKeys(row, `$.rows[${index}]`);
      return {
        enabled: Boolean(row.enabled),
        label: sanitizeRowLabel(row.label ?? row.name ?? ""),
        address: formatFlashAddress(row.address ?? 0),
      };
    }),
    mergedFilename: boundedString(config.mergedFilename ?? "", "合并输出文件名"),
    baudRate: positiveSafeInteger(config.baudRate ?? 115200, "波特率", {
      min: 1,
      max: 10_000_000,
    }),
    flashMode: sanitizeOption(config.flashMode, "Flash Mode", FLASH_MODES, "keep"),
    flashFreq: sanitizeOption(config.flashFreq, "Flash Freq", FLASH_FREQUENCIES, "keep"),
    flashSize: sanitizeOption(config.flashSize, "Flash Size", FLASH_SIZES, "keep"),
    compress: true,
    resetAfterWrite: Boolean(config.resetAfterWrite),
  };
}

export function serializeFlashConfig(config) {
  return JSON.stringify(sanitizeFlashConfig(config), null, 2);
}

export function parseFlashConfigImport(source) {
  const normalized = String(source ?? "").trim();
  if (!normalized) {
    throw new Error("配置 JSON 不能为空");
  }
  if (byteLength(normalized) > MAX_CONFIG_JSON_BYTES) {
    throw new Error(`配置 JSON 不能超过 ${MAX_CONFIG_JSON_BYTES} 字节`);
  }

  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("配置 JSON 不是有效的 JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("配置 JSON 根节点必须是对象");
  }

  const version = parsed.version;
  if (version !== FLASH_CONFIG_VERSION && version !== String(FLASH_CONFIG_VERSION)) {
    throw new Error(`仅支持版本 ${FLASH_CONFIG_VERSION} 的配置`);
  }

  return sanitizeFlashConfig(parsed);
}

export function canConfirmErase({
  isConnected = false,
  confirmationText = "",
  isSecondConfirmation = false,
} = {}) {
  return Boolean(isConnected)
    && String(confirmationText ?? "").trim() === ERASE_CONFIRM_WORD
    && Boolean(isSecondConfirmation);
}
