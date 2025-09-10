import { opfsExist, opfsRead, opfsWrite } from "./opfs";
import lamejs from "@breezystack/lamejs";

const AUDIO_BUFFER_SEGMENT_SEC = 60;
const AUDIO_SEGMENT_PREFIX = "audio_segment_";
const MP3_PADING_SAMPLES = 1105;

const getAudioFileName = (idx: number) => `${AUDIO_SEGMENT_PREFIX}${idx}.mp3`;
export class AudioSample {
  private buffers: { [idx: number]: Promise<AudioBuffer> };
  private audioContext: AudioContext;
  private setStatus: (status: string) => void;

  private numOfChannels = 1;
  private sampleRate = 44100;

  public constructor(
    audioContext: AudioContext,
    setStatus: (status: string) => void
  ) {
    this.audioContext = audioContext;
    this.buffers = {};
    this.setStatus = setStatus;
  }

  public initSample = async (
    setStatus: (status: string) => void,
    project: string
  ): Promise<boolean> => {
    this.buffers = {};

    const firstSegmentName = `${AUDIO_SEGMENT_PREFIX}0.mp3`;
    if (!(await opfsExist(project, firstSegmentName))) {
      setStatus(`Segment not found`);
      return false;
    }

    const arrayBuffer = await opfsRead(project, firstSegmentName);
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.numOfChannels = audioBuffer.numberOfChannels;
    this.sampleRate = audioBuffer.sampleRate;

    this.buffers[0] = Promise.resolve(audioBuffer);
    setStatus(`Segment initialized`);
    return true;
  };

  public isLoaded = () => this.buffers[0] !== undefined;

  public createSegmentBuffer = async (
    startSec: number,
    durationSec: number,
    project: string
  ): Promise<AudioBuffer> => {
    if (this.buffers[0] === undefined) {
      throw Error(`Not yet loaded`);
    }
    const sampleRate = this.sampleRate;
    const segmentStartIdx = Math.floor(startSec * sampleRate);
    const segmentEndIdx = Math.floor((startSec + durationSec) * sampleRate);
    const numberOfChannels = this.numOfChannels;

    const bufferDuration = AUDIO_BUFFER_SEGMENT_SEC * sampleRate;
    const startBufferIdx = Math.floor(segmentStartIdx / bufferDuration);
    const endBufferIdx = Math.floor(segmentEndIdx / bufferDuration);

    const startOffsetInBuffer =
      segmentStartIdx - startBufferIdx * bufferDuration;
    const endOffsetInBuffer = segmentEndIdx - endBufferIdx * bufferDuration;
    const totalSamples = segmentEndIdx - segmentStartIdx;

    const segmentBuffer = this.audioContext.createBuffer(
      numberOfChannels,
      totalSamples,
      sampleRate
    );

    const padding = MP3_PADING_SAMPLES;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      let writeOffset = 0;
      for (let bufIdx = startBufferIdx; bufIdx <= endBufferIdx; bufIdx++) {
        if (this.buffers[bufIdx] === undefined) {
          const arrayBuffer = await opfsRead(project, getAudioFileName(bufIdx));
          const audioBuffer = await this.audioContext.decodeAudioData(
            arrayBuffer
          );
          this.buffers[bufIdx] = Promise.resolve(audioBuffer);
        }
        const buffer = await this.buffers[bufIdx];

        let readStart, readEnd;
        if (bufIdx === startBufferIdx && bufIdx === endBufferIdx) {
          readStart = padding + startOffsetInBuffer;
          readEnd = padding + startOffsetInBuffer + totalSamples;
        } else if (bufIdx === startBufferIdx) {
          readStart = padding + startOffsetInBuffer;
          readEnd = padding + bufferDuration;
        } else if (bufIdx === endBufferIdx) {
          readStart = padding;
          readEnd = padding + endOffsetInBuffer;
        } else {
          readStart = padding;
          readEnd = padding + bufferDuration;
        }
        const channelData = buffer
          .getChannelData(channel)
          .subarray(readStart, readEnd);
        segmentBuffer.getChannelData(channel).set(channelData, writeOffset);
        writeOffset += channelData.length;
      }
    }

    (async () => {
      const nextBufIdx = endBufferIdx + 1;
      if (this.buffers[nextBufIdx] !== undefined) {
        return;
      }
      const nextFileName = getAudioFileName(nextBufIdx);
      if (!(await opfsExist(project, nextFileName))) {
        return;
      }
      this.buffers[nextBufIdx] = new Promise<AudioBuffer>(async (resolve) => {
        const arrayBuffer = await opfsRead(
          project,
          getAudioFileName(nextBufIdx)
        );
        const audioBuffer = await this.audioContext.decodeAudioData(
          arrayBuffer
        );
        resolve(audioBuffer);
      });
    })();

    return segmentBuffer;
  };
}

export const splitMp3Segments = async (
  audioBuffer: AudioBuffer,
  setStatus: (status: string) => void,
  project: string
) => {
  const duration = audioBuffer.duration;
  const totalChunks = Math.ceil(duration / AUDIO_BUFFER_SEGMENT_SEC);
  for (let i = 0; i < totalChunks; ++i) {
    const startSec = i * AUDIO_BUFFER_SEGMENT_SEC;
    const endSec = (i + 1) * AUDIO_BUFFER_SEGMENT_SEC;
    setStatus(`splitting ${i + 1} / ${totalChunks}`);
    const mp3Segment = await audioBufferToMp3Blob(
      audioBuffer,
      startSec,
      endSec
    );
    if (!mp3Segment) {
      setStatus(`Error making segment`);
      return;
    }
    await opfsWrite(project, `${AUDIO_SEGMENT_PREFIX}${i}.mp3`, mp3Segment);
  }
  setStatus(`splitting done`);
};

const audioBufferToMp3Blob = (
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  bitrate = 128
) => {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;

  const startSample = Math.floor(startSec * sampleRate);
  const endSample = Math.min(
    Math.floor(endSec * sampleRate),
    audioBuffer.length
  );

  const samplesLeft = audioBuffer
    .getChannelData(0)
    .slice(startSample, endSample);
  const samplesRight =
    numChannels > 1
      ? audioBuffer.getChannelData(1).slice(startSample, endSample)
      : null;

  const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
  const blockSize = 1152;
  const mp3Data = [];

  for (let i = 0; i < samplesLeft.length; i += blockSize) {
    const leftChunk = samplesLeft.subarray(i, i + blockSize);
    const rightChunk = samplesRight
      ? samplesRight.subarray(i, i + blockSize)
      : null;

    const leftChunkInt16 = floatTo16BitPCM(leftChunk);
    const rightChunkInt16 = rightChunk ? floatTo16BitPCM(rightChunk) : null;

    let mp3buf;
    if (numChannels === 2 && rightChunkInt16) {
      mp3buf = mp3Encoder.encodeBuffer(leftChunkInt16, rightChunkInt16);
    } else {
      mp3buf = mp3Encoder.encodeBuffer(leftChunkInt16);
    }

    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }

  const mp3buf = mp3Encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(mp3buf);
  }

  return new Blob(mp3Data, { type: "audio/mp3" });
};

function floatTo16BitPCM(input: Float32Array<ArrayBufferLike>) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export const makeSilentWav = (durationMs: number) => {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;

  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const blockAlign = (numChannels * bitsPerSample) >> 3;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let p = 0;
  function wrStr(s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  }
  function wr32(v: number) {
    view.setUint32(p, v, true);
    p += 4;
  }
  function wr16(v: number) {
    view.setUint16(p, v, true);
    p += 2;
  }

  // WAV header
  wrStr("RIFF");
  wr32(36 + dataSize);
  wrStr("WAVE");
  wrStr("fmt ");
  wr32(16);
  wr16(1);
  wr16(numChannels);
  wr32(sampleRate);
  wr32(byteRate);
  wr16(blockAlign);
  wr16(bitsPerSample);
  wrStr("data");
  wr32(dataSize);

  // PCM data = all zeros (silence)
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(p, 0, true);
    p += 2;
  }

  // Convert to base64 data URL
  const u8 = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, i + chunk))
    );
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
};
