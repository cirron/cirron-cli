// Minimal pure-JS safetensors reader. Used by `cirron traces snapshot` to
// inspect tensor contents written to `.cirron/snapshots/<span_id>/*.safetensors`
// without pulling in a native dep.
//
// File layout (see https://github.com/huggingface/safetensors):
//   [0..8)        little-endian uint64 = header byte length
//   [8..8+len)    UTF-8 JSON header
//   [8+len..]     raw tensor bytes
//
// Header shape:
//   {
//     "__metadata__": { ... },   // optional
//     "<tensor_name>": {
//       "dtype": "F32" | "F16" | "BF16" | "F64" | "I8" | "I16" | "I32" | "I64"
//              | "U8" | "U16" | "U32" | "U64" | "BOOL",
//       "shape": [int, ...],
//       "data_offsets": [start, end]   // relative to byte 0 of tensor payload
//     },
//     ...
//   }

import fs, { promises as fsp } from "node:fs";

export type SafetensorsDtype =
  | "F64"
  | "F32"
  | "F16"
  | "BF16"
  | "I64"
  | "I32"
  | "I16"
  | "I8"
  | "U64"
  | "U32"
  | "U16"
  | "U8"
  | "BOOL";

export interface SafetensorsTensorInfo {
  byteSize: number;
  dataOffsets: [number, number]; // relative to start of tensor payload
  dtype: SafetensorsDtype;
  name: string;
  shape: number[];
}

export interface SafetensorsFileInfo {
  fileSize: number;
  headerByteLen: number;
  metadata: Record<string, unknown>;
  path: string;
  tensors: SafetensorsTensorInfo[];
}

const DTYPE_BYTES: Record<SafetensorsDtype, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U64: 8,
  U32: 4,
  U16: 2,
  U8: 1,
  BOOL: 1,
};

/**
 * Read a safetensors file's header without loading any tensor data.
 *
 * @param path - Path to the `.safetensors` file.
 * @returns The tensor names, dtypes, shapes and byte offsets.
 * @throws If the file is malformed or the header is not valid JSON.
 */
export async function readSafetensorsInfo(
  path: string
): Promise<SafetensorsFileInfo> {
  const stat = await fsp.stat(path);
  const fd = await fsp.open(path, "r");
  try {
    // Read 8-byte little-endian header length.
    const lenBuf = Buffer.alloc(8);
    await fd.read(lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (headerLen < 0 || headerLen > stat.size - 8) {
      throw new Error(
        `safetensors: header length ${headerLen} out of range for file of ${stat.size} bytes`
      );
    }
    const headerBuf = Buffer.alloc(headerLen);
    await fd.read(headerBuf, 0, headerLen, 8);
    const headerJson = JSON.parse(headerBuf.toString("utf-8")) as Record<
      string,
      unknown
    >;

    const metadata =
      (headerJson["__metadata__"] as Record<string, unknown> | undefined) ?? {};
    const tensors: SafetensorsTensorInfo[] = [];
    for (const [name, raw] of Object.entries(headerJson)) {
      if (name === "__metadata__") {
        continue;
      }
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const dtype = entry["dtype"] as SafetensorsDtype;
      const shape = Array.isArray(entry["shape"])
        ? (entry["shape"] as unknown[]).map((n) => Number(n))
        : [];
      const offsetsRaw = entry["data_offsets"];
      if (!Array.isArray(offsetsRaw) || offsetsRaw.length !== 2) {
        continue;
      }
      const dataOffsets: [number, number] = [
        Number(offsetsRaw[0]),
        Number(offsetsRaw[1]),
      ];
      const byteSize = dataOffsets[1] - dataOffsets[0];
      tensors.push({ name, dtype, shape, byteSize, dataOffsets });
    }

    return {
      path,
      fileSize: stat.size,
      headerByteLen: headerLen,
      metadata,
      tensors,
    };
  } finally {
    await fd.close();
  }
}

// Decoded tensor payload — numeric tensors return a numeric typed array
// (Float32Array etc.). 64-bit int types return BigInt64/BigUint64 arrays.
// F16/BF16 are returned as Uint16Array; `tensorPreview` handles the upcast.
interface SafetensorsTensorData {
  info: SafetensorsTensorInfo;
  values:
    | Float64Array
    | Float32Array
    | Uint16Array
    | BigInt64Array
    | Int32Array
    | Int16Array
    | Int8Array
    | BigUint64Array
    | Uint32Array
    | Uint8Array;
}

/**
 * Read one tensor's raw values out of a safetensors file.
 *
 * Only the requested tensor's byte range is read, so this stays cheap on a
 * file holding many tensors.
 *
 * @param path - Path to the `.safetensors` file.
 * @param tensorName - Tensor to read.
 * @returns The tensor's dtype, shape and decoded values.
 * @throws If the tensor is absent or its dtype is unsupported.
 */
export async function readSafetensorsTensor(
  path: string,
  tensorName: string
): Promise<SafetensorsTensorData> {
  const info = await readSafetensorsInfo(path);
  const tensor = info.tensors.find((t) => t.name === tensorName);
  if (!tensor) {
    throw new Error(
      `Tensor "${tensorName}" not found in ${path}. Available: ${info.tensors
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  const expected = shapeElementCount(tensor.shape) * DTYPE_BYTES[tensor.dtype];
  if (tensor.byteSize !== expected) {
    throw new Error(
      `safetensors: tensor "${tensorName}" byte size ${tensor.byteSize} does not match shape × dtype (${expected})`
    );
  }

  const absoluteStart = 8 + info.headerByteLen + tensor.dataOffsets[0];
  const buf = Buffer.alloc(tensor.byteSize);
  const fd = await fsp.open(path, "r");
  try {
    await fd.read(buf, 0, tensor.byteSize, absoluteStart);
  } finally {
    await fd.close();
  }

  // Copy into a fresh ArrayBuffer to avoid aliasing the Node Buffer pool.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const values = typedArrayForDtype(tensor.dtype, ab);
  return { info: tensor, values };
}

function shapeElementCount(shape: number[]): number {
  if (shape.length === 0) {
    return 1; // scalar
  }
  let n = 1;
  for (const d of shape) {
    n *= d;
  }
  return n;
}

function typedArrayForDtype(
  dtype: SafetensorsDtype,
  buf: ArrayBuffer
): SafetensorsTensorData["values"] {
  switch (dtype) {
    case "F64":
      return new Float64Array(buf);
    case "F32":
      return new Float32Array(buf);
    case "F16":
      return new Uint16Array(buf); // caller uses float16ToFloat32
    case "BF16":
      return new Uint16Array(buf);
    case "I64":
      return new BigInt64Array(buf);
    case "I32":
      return new Int32Array(buf);
    case "I16":
      return new Int16Array(buf);
    case "I8":
      return new Int8Array(buf);
    case "U64":
      return new BigUint64Array(buf);
    case "U32":
      return new Uint32Array(buf);
    case "U16":
      return new Uint16Array(buf);
    case "U8":
      return new Uint8Array(buf);
    case "BOOL":
      return new Uint8Array(buf);
    default:
      throw new Error(`Unsupported dtype: ${dtype as string}`);
  }
}

function float16ToFloat32(h: number): number {
  const s = (h & 0x80_00) >> 15;
  const e = (h & 0x7c_00) >> 10;
  const f = h & 0x03_ff;
  if (e === 0) {
    return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  }
  if (e === 0x1f) {
    return f
      ? Number.NaN
      : s
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
  }
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

function bfloat16ToFloat32(h: number): number {
  // BF16 is the top 16 bits of an F32 — shift into place and reinterpret.
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = (h << 16) >>> 0;
  return new Float32Array(buf)[0]!;
}

// Copy the first (or last) N values from a decoded tensor and return them
// as plain JS numbers. F16/BF16 get upcast to f32 so they print nicely.
/**
 * Take the first or last N values of a tensor for display.
 *
 * @param data - A tensor read by `readSafetensorsTensor`.
 * @param n - How many values to take.
 * @param from - Which end to take them from.
 * @returns Up to `n` values.
 */
export function tensorPreview(
  data: SafetensorsTensorData,
  n: number,
  from: "head" | "tail" = "head"
): Array<number | bigint> {
  const vals = data.values;
  const len = vals.length;
  const take = Math.min(n, len);
  const start = from === "head" ? 0 : Math.max(0, len - take);
  const end = from === "head" ? take : len;
  const out: Array<number | bigint> = [];
  for (let i = start; i < end; i++) {
    const raw = vals[i]!;
    if (data.info.dtype === "F16") {
      out.push(float16ToFloat32(raw as number));
    } else if (data.info.dtype === "BF16") {
      out.push(bfloat16ToFloat32(raw as number));
    } else {
      out.push(raw);
    }
  }
  return out;
}

/**
 * Whether a readable safetensors file exists at a path.
 *
 * @param path - Path to check.
 * @returns True when the file exists and is readable.
 */
export function safetensorsFileExists(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

// Write a single-tensor safetensors file by extracting the named tensor
// from an existing blob. Used by `cirron traces snapshot <span> <tensor>
// --export <path>` so the user gets only what they asked for instead of
// the entire span's weights.
/**
 * Copy one tensor out of a safetensors file into a new single-tensor file.
 *
 * Used by `traces snapshot --export` so the caller gets only the tensor asked
 * for, rather than every tensor recorded for that span.
 *
 * @param sourcePath - File to read from.
 * @param tensorName - Tensor to extract.
 * @param destPath - File to write.
 * @throws If the tensor is absent from the source.
 */
export async function writeSingleTensorSafetensors(
  sourcePath: string,
  tensorName: string,
  destPath: string
): Promise<void> {
  const info = await readSafetensorsInfo(sourcePath);
  const tensor = info.tensors.find((t) => t.name === tensorName);
  if (!tensor) {
    throw new Error(
      `Tensor "${tensorName}" not found in ${sourcePath}. Available: ${info.tensors
        .map((t) => t.name)
        .join(", ")}`
    );
  }

  // New header: tensor gets offsets [0, byteSize).
  const newHeader: Record<string, unknown> = {
    [tensorName]: {
      dtype: tensor.dtype,
      shape: tensor.shape,
      data_offsets: [0, tensor.byteSize],
    },
  };
  // Pad in BYTES, not JS string length: one code point can be 2-4 UTF-8
  // bytes, so a non-ASCII tensor name would otherwise misalign the header.
  const headerJson = JSON.stringify(newHeader);
  let headerBytes = Buffer.from(headerJson, "utf-8");
  const pad = (8 - (headerBytes.length % 8)) % 8;
  if (pad !== 0) {
    headerBytes = Buffer.concat([headerBytes, Buffer.alloc(pad, 0x20)]);
  }

  // Read the source tensor bytes.
  const absoluteStart = 8 + info.headerByteLen + tensor.dataOffsets[0];
  const tensorBuf = Buffer.alloc(tensor.byteSize);
  const srcFd = await fsp.open(sourcePath, "r");
  try {
    await srcFd.read(tensorBuf, 0, tensor.byteSize, absoluteStart);
  } finally {
    await srcFd.close();
  }

  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBytes.length), 0);

  const destFd = await fsp.open(destPath, "w");
  try {
    await destFd.write(lenBuf);
    await destFd.write(headerBytes);
    await destFd.write(tensorBuf);
  } finally {
    await destFd.close();
  }
}
