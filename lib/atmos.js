/**
 * Atmos / immersive-audio detection helpers.
 *
 * One rule governs everything here: **never label a stream Atmos because it
 * would be nice. Label it only on evidence.** BitChord reads the same hints
 * out of the row and the stream and shows the immersive badge from them; an
 * addon that emits them hopefully trades a real badge for a broken playback.
 *
 * Vocabulary shared with BitChord's own reader (ATMOS_HINT):
 *   atmos | dolby | eac3[_-]?joc | ec-?3
 * We add multichannel-FLAC evidence on top: a FLAC whose STREAMINFO says
 * more than 2 channels is immersive audio in a lossless container — true for
 * Atmos-mastered FLAC, 5.1/7.1 PCM renders and most "Dolby Atmos Music"
 * Blu-ray rips in FLAC form.
 */

const ATMOS_HINT = /atmos|dolby|eac3[_-]?joc|ec-?3/i;

/** True when any of the supplied strings mentions an immersive format. */
export function nameSaysAtmos(...parts) {
  return ATMOS_HINT.test(parts.filter(Boolean).join(' '));
}

/**
 * Evidence from a parsed FLAC STREAMINFO: >2 channels means multichannel.
 * `atmos` is only set when the name/label also says so — a 5.1 PCM FLAC is
 * multichannel lossless but not necessarily an Atmos mix, and the label must
 * not claim otherwise. The `audioMode` we expose for multichannel is
 * `MULTICHANNEL`, which BitChord treats as an unknown mode (ignored), and
 * the quality text says "multichannel", which is strictly true.
 */
export function channelEvidence(info) {
  if (!info || !Number.isFinite(info.channels)) return { multichannel: false, atmos: false };
  return { multichannel: info.channels > 2, atmos: false };
}
