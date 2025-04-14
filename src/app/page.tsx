"use client";

import { useState, useRef, useEffect } from "react";
import srtParser from "srt-parser-2";

const LS_INDEX = "lastPlayIndex";
const BATCH_PLAY_LENGTH = 50;

const loadPlayIndex = () => {
  if (window.localStorage) {
    const idxStr = window.localStorage.getItem(LS_INDEX);
    if (!idxStr) return 0;
    return parseInt(idxStr);
  }
  return 0;
};

const getRowId = (index: number) => `id-${index}`;

const savePlayIndex = (index: number) => {
  if (window.localStorage) {
    window.localStorage.setItem(LS_INDEX, index.toString());
  }
};

interface FilePickerAcceptType {
  description: string;
  accept: {
    [key: string]: string[];
  };
}

interface FilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}

declare global {
  interface Window {
    showOpenFilePicker(
      options?: FilePickerOptions
    ): Promise<FileSystemFileHandle[]>;
  }
}

const OPFS_AUDIO_NAME = "audio.mp3";
const OPFS_SRT_NAME = "transcript.srt";

const opfsWrite = async (file: File, fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await opfsFileHandle.createWritable();

  await writable.write(file);
  await writable.close();
};

const opfsRead = async (fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName);
  const ab = (await opfsFileHandle.getFile()).arrayBuffer();
  return ab;
};

const opfsExist = async (filename: string) => {
  const root = await navigator.storage.getDirectory();
  try {
    await root.getFileHandle(filename, { create: false });
    return true;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return false;
    } else {
      throw err;
    }
  }
};

interface Segment {
  startTime: number;
  endTime: number;
  text: string;
}

const createSegmentBuffer = (
  ctx: AudioContext,
  sourceBuffer: AudioBuffer,
  startSec: number,
  durationSec: number
): AudioBuffer => {
  const sampleRate = sourceBuffer.sampleRate;
  const numberOfChannels = sourceBuffer.numberOfChannels;

  const segmentBuffer = ctx.createBuffer(
    numberOfChannels,
    Math.floor(durationSec * sampleRate),
    sampleRate
  );

  for (let channel = 0; channel < numberOfChannels; channel++) {
    segmentBuffer.copyToChannel(
      sourceBuffer
        .getChannelData(channel)
        .subarray(
          Math.floor(startSec * sampleRate),
          Math.floor(startSec * sampleRate) +
            Math.floor(durationSec * sampleRate)
        ),
      channel,
      0
    );
  }

  return segmentBuffer;
};

interface PlayContext {
  audioContext: AudioContext;
  audioBuffer?: AudioBuffer;
  playInfo?: {
    rangeInfo?: { beginIdx: number; endIdx: number };
    abSrcNode: AudioBufferSourceNode;
    stopListener?: () => void;
  };
}

const stopPlayback = (playContext: PlayContext) => {
  const playInfo = playContext.playInfo;
  if (!playInfo) {
    return;
  }

  if (playInfo.stopListener) {
    playInfo.abSrcNode.removeEventListener("ended", playInfo.stopListener);
  }
  playInfo.abSrcNode.stop();
  playContext.playInfo = undefined;
};

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const playCtxRef = useRef<PlayContext | undefined>(undefined);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIndex, setSegIndex] = useState<number>(0);

  useEffect(() => {
    const audioContext = new AudioContext();
    const playContext: PlayContext = { audioContext };
    playCtxRef.current = playContext;

    const lastIdx = loadPlayIndex();
    setSegIndex(lastIdx);

    (async () => {
      if (!opfsExist(OPFS_AUDIO_NAME)) {
        setStatus(`No audio file cached.`);
        return;
      }
      const arrayBuffer = await opfsRead(OPFS_AUDIO_NAME);
      setStatus("audio buffer found. decoding.");
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      playContext.audioBuffer = audioBuffer;

      const srtContent = await opfsRead(OPFS_SRT_NAME);
      const decoder = new TextDecoder();
      const srtString = decoder.decode(srtContent);
      setStatus("srt file found. setting.");

      const parser = new srtParser();
      const segments: Segment[] = parser.fromSrt(srtString).map((elem) => ({
        startTime: elem.startSeconds,
        endTime: elem.endSeconds,
        text: elem.text,
      }));
      setSegments(segments);

      setStatus(`current: ${lastIdx + 1} / ${segments.length}`);
    })();
  }, []);

  const playAudioSegment = async (index: number, loop: boolean) => {
    try {
      const playContext = playCtxRef.current;
      if (!playContext) return;
      const { audioContext, audioBuffer } = playContext;
      if (!audioBuffer) return;

      const prevRangeInfo = playContext.playInfo?.rangeInfo;
      stopPlayback(playContext);

      const segment = segments[index];
      if (!segment) {
        return;
      }
      const startSec = segment.startTime;
      const durationSec = segment.endTime - segment.startTime;

      setSegIndex(index);
      savePlayIndex(index);

      const segmentBuffer = createSegmentBuffer(
        audioContext,
        audioBuffer,
        startSec,
        durationSec
      );

      const abSrcNode = audioContext.createBufferSource();
      abSrcNode.buffer = segmentBuffer; // Use the smaller segment buffer
      abSrcNode.connect(audioContext.destination);
      abSrcNode.loop = loop;

      let stopListener: undefined | (() => void) = undefined;
      let rangeInfo: undefined | { beginIdx: number; endIdx: number } =
        undefined;
      if (loop === false) {
        rangeInfo = prevRangeInfo
          ? prevRangeInfo
          : {
              beginIdx: index,
              endIdx: Math.min(segments.length, index + BATCH_PLAY_LENGTH),
            };
        let nextIndex = index + 1;
        if (nextIndex >= rangeInfo.endIdx) {
          nextIndex = rangeInfo.beginIdx;
        }
        stopListener = () => {
          playAudioSegment(nextIndex, loop);
        };
        abSrcNode.addEventListener("ended", stopListener);
      }

      playContext.playInfo = { abSrcNode, stopListener, rangeInfo };
      abSrcNode.start();
      const rangeStr = rangeInfo
        ? `[${rangeInfo.beginIdx + 1}~${rangeInfo.endIdx}]`
        : "";
      setStatus(`current: ${index + 1} / ${segments.length} ${rangeStr}`);
    } catch (error) {
      console.error("Error playing audio:", error);
      setStatus("Error playing audio segment");
    }
  };

  const handleFileSelect = async (input: "audio" | "srt") => {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        types:
          input === "audio"
            ? [
                {
                  description: "Audio Files",
                  accept: { "audio/*": [".mp3", ".wav", ".m4a", ".ogg"] },
                },
              ]
            : [
                {
                  description: "Subtitle Files",
                  accept: { "text/plain": [".srt"] },
                },
              ],
      });

      const file = await fileHandle.getFile();
      await opfsWrite(
        file,
        input === "audio" ? OPFS_AUDIO_NAME : OPFS_SRT_NAME
      );
    } catch (error) {
      console.error("Error handling file:", error);
      setStatus(`Error processing ${input} file`);
    }
  };

  const playCtx = playCtxRef.current;
  if (!playCtx) {
    return null;
  }

  const { audioBuffer, playInfo } = playCtx;

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 p-8">
        <div className="flex gap-4">
          <button
            onClick={() => handleFileSelect("audio")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Select Audio File
          </button>
          <button
            onClick={() => handleFileSelect("srt")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Select SRT File
          </button>
        </div>

        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 py-4 w-full flex flex-col items-center gap-4 p-8">
          {audioBuffer && (
            <div className="flex gap-4">
              <button
                onClick={() => {
                  if (playInfo) {
                    stopPlayback(playCtx);
                    setStatus(status + " stopped");
                  } else {
                    playAudioSegment(segIndex, false);
                  }
                }}
                className={`cursor-pointer ${
                  playInfo
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-green-500 hover:bg-green-600"
                } text-white px-6 py-3 rounded-lg font-medium transition-colors`}
              >
                {playInfo ? "Stop" : "Play"}
              </button>
            </div>
          )}
          <p
            onClick={() => {
              document
                .getElementById(getRowId(segIndex))
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="text-2xl text-gray-600 dark:text-gray-400"
          >
            {status}
          </p>
          {audioBuffer && (
            <div className="flex gap-8">
              <div
                onClick={() =>
                  segIndex > 0 && playAudioSegment(segIndex - 1, true)
                }
                className="cursor-pointer bg-blue-500 hover:bg-blue-600 px-4 rounded-2xl font-medium transition-colors text-6xl border-2 border-blue-500 text-white"
              >
                Prev
              </div>
              <div
                onClick={() =>
                  segIndex < segments.length - 1 &&
                  playAudioSegment(segIndex + 1, true)
                }
                className="cursor-pointer bg-blue-500 hover:bg-blue-600 px-4 rounded-2xl font-medium transition-colors text-6xl border-2 border-blue-500 text-white"
              >
                Next
              </div>
            </div>
          )}
        </div>
        {segments.length > 0 && (
          <div className="mt-4 max-w-[90%]">
            <table>
              <thead>
                <tr className="bg-gray-800">
                  <th className="p-2 w-16">No.</th>
                  <th className="p-2 min-w-0 text-left">Text</th>
                  <th className="p-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment, index) => {
                  const betweenRange = playInfo?.rangeInfo
                    ? playInfo.rangeInfo.beginIdx <= index &&
                      index < playInfo.rangeInfo.endIdx
                    : false;
                  return (
                    <tr
                      key={index}
                      id={getRowId(index)}
                      style={{
                        backgroundColor:
                          index === segIndex ? "#4B5563" : "transparent",
                      }}
                    >
                      <td
                        className={`p-0 text-center ${
                          betweenRange ? "border-l-2 border-blue-500" : ""
                        }`}
                      >
                        {index + 1}
                      </td>
                      <td className="p-0 break-words min-w-0">
                        {segment.text}
                      </td>
                      <td className="p-0">
                        <button
                          className="bg-blue-500 text-white px-0 py-0 rounded"
                          onClick={() => playAudioSegment(index, true)}
                        >
                          Play
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
