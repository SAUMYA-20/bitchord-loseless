/**
 * FLAC stream introspection.
 *
 * The catalogues this addon draws on serve FLAC as an extensionless
 * `application/octet-stream` response and advertise nothing about the audio
 * inside. BitChord does not take a source's word for it — the quality badge a
 * listener sees is settled against what their device actually decodes, and a
 * source that overstates what it serves spends a track finding out. So the
 * honest answer comes from the file itself.
 *
 * Layout, per the FLAC specification:
 *
 *   "fLaC"                     4 bytes   magic
 *   block header               4 bytes   bit7 = last-block, bits0-6 = type
 *   STREAMINFO                34 bytes   mandatory, and always first
 *     16  min block size
 *     16  max block size
 *     24  min frame size
 *     24  max frame size
 *     20  sample rate in Hz
 *      3  channels - 1
 *      5  bits per sample - 1
 *     36  total samples
 *
 * The last three share a single 64-bit big-endian word.
 */

/** Bytes needed to read STREAMINFO: magic + header + the 34-byte body. */
export const STREAMINFO_BYTES = 4 + 4 + 34;

/** The literal a FLAC file must begin with. */
const MAGIC = Buffer.from('fLaC', 'ascii');

/** STREAMINFO is metadata block type 0. */
const BLOCK_STREAMINFO = 0;

/**
 * Reads a FLAC header and returns what it says about the audio, or null when
 * the bytes are not a FLAC header. Null is a real answer: the URL handed over
 * does not carry FLAC, which is exactly the fact a caller needs in order to
 * refuse to label it lossless.
 */
export function parseFlacStreamInfo(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) return null;
  if (!head.subarray(0, 4).equals(MAGIC)) return null;

  const isLastBlock = (head[4] & 0x80) !== 0;
  const blockType = head[4] & 0x7f;

  if (blockType !== BLOCK_STREAMINFO) return null;

  const body = head.subarray(8, 8 + 34);
  if (body.length < 34) return null;

  const minBlockSize = body.readUInt16BE(0);
  const maxBlockSize = body.readUInt16BE(2);
  const minFrameSize = (body[4] << 16) | (body[5] << 8) | body[6];
  const maxFrameSize = (body[7] << 16) | (body[8] << 8) | body[9];

  const packed = body.readBigUInt64BE(10);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitDepth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);

  if (!sampleRate) return null;

  return {
    sampleRate,
    channels,
    bitDepth,
    totalSamples,
    durationSec: Math.round((totalSamples / sampleRate) * 100) / 100,
    minBlockSize,
    maxBlockSize,
    minFrameSize,
    maxFrameSize,
    isLastBlock,
  };
}

/**
 * Bitrate in kbps from a byte count and a duration.
 */
export function flacKbps(bytes, durationSec) {
  if (!Number.isFinite(bytes) || !Number.isFinite(durationSec)) return null;
  if (bytes <= 0 || durationSec <= 0) return null;
  return Math.round((bytes * 8) / durationSec / 1000);
}

/**
 * A human-readable quality string for the `quality` field in the stream
 * response. BitChord parses this free text for a rating, so it is written to
 * be parsed: "16-bit / 44.1 kHz", "24-bit / 96 kHz", "Dolby Atmos".
 *
 * `atmos` is passed only when something actually said this file is Atmos —
 * a filename, a multichannel layout, or an explicit upstream tag. It is never
 * inferred from a lossy codec label.
 */
export function describeQuality({ sampleRate, bitDepth, channels, atmos = false }) {
  if (atmos) {
    const detail = sampleRate && bitDepth
      ? `multichannel ${bitDepth}-bit / ${(sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`
      : 'multichannel';
    return `Dolby Atmos · ${detail}`;
  }
  if (sampleRate && bitDepth) {
    const hires = sampleRate > 48000 || bitDepth > 16;
    return `${hires ? 'Hi-Res' : 'Lossless'} FLAC · ${bitDepth}-bit / ${
      (sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
    } kHz${channels > 2 ? ` · ${channels}ch` : ''}`;
  }
  return 'Lossless FLAC · bit depth read from the FLAC header';
}
