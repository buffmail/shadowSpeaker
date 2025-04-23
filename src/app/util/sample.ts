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
    setStatus: (status: string) => void
  ): Promise<boolean> => {
    this.buffers = {};

    const firstSegmentName = `${AUDIO_SEGMENT_PREFIX}0.mp3`;
    if (!(await opfsExist(firstSegmentName))) {
      setStatus(`Segment not found`);
      return false;
    }

    const arrayBuffer = await opfsRead(firstSegmentName);
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
    durationSec: number
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
          const arrayBuffer = await opfsRead(getAudioFileName(bufIdx));
          const audioBuffer = await this.audioContext.decodeAudioData(
            arrayBuffer
          );
          window.console.log(`loading segment ${bufIdx}`);
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
      if (!(await opfsExist(nextFileName))) {
        return;
      }
      this.buffers[nextBufIdx] = new Promise<AudioBuffer>(async (resolve) => {
        const arrayBuffer = await opfsRead(getAudioFileName(nextBufIdx));
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
  setStatus: (status: string) => void
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
    await opfsWrite(`${AUDIO_SEGMENT_PREFIX}${i}.mp3`, mp3Segment);
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
