"use client";

import { useState, useRef, useEffect } from "react";
import srtParser from "srt-parser-2";

const LS_INDEX = "lastPlayIndex";

const loadPlayIndex = () => {
  if (window.localStorage) {
    const idxStr = window.localStorage.getItem(LS_INDEX);
    if (!idxStr) return 0;
    return parseInt(idxStr);
  }
  return 0;
};

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

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const sourceNodeRef = useRef<AudioBufferSourceNode | undefined>(undefined);
  const audioBufferRef = useRef<AudioBuffer | undefined>(undefined);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIndex, setSegIndex] = useState<number>(0);

  useEffect(() => {
    const lastIdx = loadPlayIndex();
    setSegIndex(lastIdx);

    (async () => {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }

      const arrayBuffer = await opfsRead(OPFS_AUDIO_NAME);
      const audioBuffer = await audioContextRef.current.decodeAudioData(
        arrayBuffer
      );

      audioBufferRef.current = audioBuffer;

      const srtContent = await opfsRead(OPFS_SRT_NAME);
      const decoder = new TextDecoder();
      const srtString = decoder.decode(srtContent);

      const parser = new srtParser();
      const segments: Segment[] = parser.fromSrt(srtString).map((elem) => ({
        startTime: elem.startSeconds,
        endTime: elem.endSeconds,
        text: elem.text,
      }));
      setSegments(segments);

      setStatus("Audio loaded. Click Play to start loop.");
    })();
  }, []);

  const stopPlayback = () => {
    if (!sourceNodeRef) {
      return;
    }
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = undefined;
    setIsPlaying(false);
  };

  const playAudioSegment = async (index: number, loop: boolean) => {
    try {
      if (!audioContextRef.current || !audioBufferRef.current) return;
      stopPlayback();

      const ctx = audioContextRef.current;
      const segment = segments[index];
      if (!segment) {
        return;
      }
      const startSec = segment.startTime;
      const durationSec = segment.endTime - segment.startTime;

      setSegIndex(index);
      savePlayIndex(index);

      const segmentBuffer = createSegmentBuffer(
        ctx,
        audioBufferRef.current,
        startSec,
        durationSec
      );

      const source = ctx.createBufferSource();
      source.buffer = segmentBuffer; // Use the smaller segment buffer
      source.connect(ctx.destination);
      source.loop = loop;

      sourceNodeRef.current = source;

      if (loop === false && index < segments.length - 1) {
        source.addEventListener("ended", () => {
          if (sourceNodeRef.current) {
            playAudioSegment(index + 1, loop);
          }
        });
      }

      source.start();
      setIsPlaying(true);
      setStatus(`current: ${index + 1} / ${segments.length}`);
    } catch (error) {
      console.error("Error playing audio:", error);
      setStatus("Error playing audio segment");
      setIsPlaying(false);
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

  const mediaLoaded = audioBufferRef.current !== undefined;

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
          {audioBufferRef.current && (
            <div className="flex gap-4">
              <button
                onClick={() =>
                  isPlaying ? stopPlayback() : playAudioSegment(segIndex, false)
                }
                className={`cursor-pointer ${
                  isPlaying
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-green-500 hover:bg-green-600"
                } text-white px-6 py-3 rounded-lg font-medium transition-colors`}
              >
                {isPlaying ? "Stop" : "Play"}
              </button>
            </div>
          )}
          {status && (
            <p className="text-sm text-gray-600 dark:text-gray-400">{status}</p>
          )}
          {mediaLoaded && (
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
          <div className="mt-4 w-full max-w-2xl">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-800">
                  <th className="p-2 w-16">No.</th>
                  <th className="p-2 text-left">Text</th>
                  <th className="p-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment, index) => (
                  <tr
                    key={index}
                    style={{
                      backgroundColor:
                        index === segIndex ? "#4B5563" : "transparent",
                    }}
                  >
                    <td className="p-0 text-center">{index + 1}</td>
                    <td className="p-0">{segment.text}</td>
                    <td className="p-0">
                      <button
                        className="bg-blue-500 text-white px-3 py-1 rounded"
                        onClick={() => playAudioSegment(index, true)}
                      >
                        Play
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
